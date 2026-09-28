// Shared constants. Imported by the service worker and by extension pages.
// Content scripts are classic scripts and cannot import this; keep any values
// they need duplicated (and commented) at the top of the content script.

export const EXTENSION_NAME = 'NoTrain';

/** Where the extension fetches registry updates from (data only, never code). */
export const REMOTE_REGISTRY_URL =
  'https://raw.githubusercontent.com/tayaa710/ai-opt-out/main/registry/dist/registry.json';

/** Bundled copy shipped with the extension, used on first run and as fallback. */
export const BUNDLED_REGISTRY_PATH = 'data/registry.json';

/** Compiled registry format this build understands. Bump on breaking changes. */
export const REGISTRY_FORMAT_VERSION = 1;

/** Settings/userState storage schema version, for migrations. */
export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_KEYS = Object.freeze({
  settings: 'settings',
  userState: 'userState',
  registry: 'registry',
  registryMeta: 'registryMeta',
  alerts: 'alerts',
  history: 'history',
});

export const ALARMS = Object.freeze({
  registrySync: 'notrain-registry-sync',
  reminders: 'notrain-reminders',
});

export const REGISTRY_SYNC_PERIOD_MINUTES = 60 * 24 * 7; // weekly
export const REMINDER_CHECK_PERIOD_MINUTES = 60 * 24; // daily check, reminders fire per settings.reminderIntervalDays

export const HISTORY_LIMIT = 500;
export const ALERTS_LIMIT = 200;

/** Per opt-out status stored in userState. Absent means 'not_started'. */
export const OPT_OUT_STATUS = Object.freeze({
  notStarted: 'not_started',
  done: 'done', // setting switched off (verified by automation or confirmed by the user)
  sent: 'sent', // request letter / form submitted, waiting on the company
  skipped: 'skipped', // user decided not to
  needsAttention: 'needs_attention', // flipped back on, or verification failed
});

/** How an opt-out was completed. */
export const METHODS = Object.freeze(['auto', 'guided', 'manual', 'letter']);

/** Outcomes reported by the in-page engine. */
export const RUN_OUTCOMES = Object.freeze({
  success: 'success', // state changed and verified
  already: 'already', // was already in the desired state
  notFound: 'not_found', // could not find the control
  needsLogin: 'needs_login', // user is not signed in
  failed: 'failed', // unexpected error / state did not change
  cancelled: 'cancelled', // user stopped it
  mismatch: 'mismatch', // verify: setting is in the wrong state (flipped back)
});

export const ALERT_KINDS = Object.freeze({
  policyChange: 'policy_change',
  flipBack: 'flip_back',
  reminder: 'reminder',
  newService: 'new_service',
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  onboarded: false,
  region: 'OTHER',
  notifications: Object.freeze({ policyChanges: true, flipBacks: true, reminders: true }),
  reminderIntervalDays: 90,
  autoSync: true,
  passiveChecks: true,
  profile: Object.freeze({ fullName: '', email: '' }),
});
