import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_BASE, installChromeMock, jsonResponse, senders, tick } from './helpers/chrome-mock.mjs';
import { TEST_MANIFEST, bumpPolicy, exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';
import {
  FIRST_SYNC_DELAY_MINUTES,
  checkReminders,
  ensureAlarms,
  ensureReady,
  handleAlarm,
  handleInstalled,
  handleStartup,
  handleStorageChanged,
  syncIfDue,
} from '../../extension/background/lifecycle.js';
import {
  ALARMS,
  REGISTRY_SYNC_PERIOD_MINUTES,
  REMINDER_CHECK_PERIOD_MINUTES,
  REMOTE_REGISTRY_URL,
} from '../../extension/lib/constants.js';
import { readLocal, writeLocal } from '../../extension/lib/storage.js';
import { _resetIconCheck } from '../../extension/lib/notify.js';

const TOGGLE = 'improve-model-toggle';
const REGISTRY = makeRegistry([makeService(), exampleService()]);
let mock;

beforeEach(() => {
  _resetIconCheck();
  mock = installChromeMock({ manifest: TEST_MANIFEST, registry: REGISTRY });
});
afterEach(() => mock.uninstall());

const remoteCalls = () => mock.fetchCalls.filter((c) => c.url === REMOTE_REGISTRY_URL).length;

describe('install / update / startup', () => {
  test('install: defaults, bundled registry, alarms and the welcome tab', async () => {
    await handleInstalled({ reason: 'install' });
    const { settings, registry, registryMeta } = await readLocal(['settings', 'registry', 'registryMeta']);
    assert.equal(settings.onboarded, false);
    assert.equal(registry.services.length, 2);
    assert.equal(registryMeta.source, 'bundled');
    assert.deepEqual(
      mock.tabs.created.map((t) => t.url),
      [`${EXTENSION_BASE}dashboard/dashboard.html#/welcome`],
    );
    const sync = await mock.alarms.get(ALARMS.registrySync);
    assert.equal(sync.periodInMinutes, REGISTRY_SYNC_PERIOD_MINUTES);
    assert.ok(
      sync.scheduledTime >= Date.now() + (FIRST_SYNC_DELAY_MINUTES - 1) * 60_000,
      'first sync is delayed',
    );
    assert.equal((await mock.alarms.get(ALARMS.reminders)).periodInMinutes, REMINDER_CHECK_PERIOD_MINUTES);
    assert.equal(remoteCalls(), 0, 'no network request at install');
  });

  test('install does not reopen onboarding for an onboarded user', async () => {
    await writeLocal({ settings: { schemaVersion: 1, onboarded: true } });
    await handleInstalled({ reason: 'install' });
    assert.equal(mock.tabs.created.length, 0);
  });

  test('update: migrates, installs a newer bundled registry and alerts about tracked changes', async () => {
    await handleInstalled({ reason: 'install' });
    await writeLocal({
      userState: {
        services: {
          chatgpt: {
            tracked: true,
            source: 'manual',
            addedAt: '2026-09-01T00:00:00.000Z',
            knownPolicyVersion: 1,
            optOuts: {},
          },
        },
      },
    });
    mock.registryBody = makeRegistry(
      [bumpPolicy(makeService()), exampleService()],
      '2026-09-20T00:00:00.000Z',
    );
    mock.tabs.created.length = 0;
    await handleInstalled({ reason: 'update', previousVersion: '0.9.0' });
    const { registry, alerts } = await readLocal(['registry', 'alerts']);
    assert.equal(registry.generatedAt, '2026-09-20T00:00:00.000Z');
    assert.equal(alerts[0].kind, 'policy_change');
    assert.equal(mock.tabs.created.length, 0);
  });

  test('ensureAlarms is idempotent and repairs a wrong period', async () => {
    await ensureAlarms();
    await ensureAlarms();
    assert.equal(mock.alarms.createCalls, 2);
    await mock.alarms.create(ALARMS.reminders, { periodInMinutes: 5 });
    await ensureAlarms();
    assert.equal((await mock.alarms.get(ALARMS.reminders)).periodInMinutes, REMINDER_CHECK_PERIOD_MINUTES);
  });

  test('startup syncs only when the registry is stale', async () => {
    await handleStartup();
    assert.equal(remoteCalls(), 0);
    const { registryMeta } = await readLocal(['registryMeta']);
    await writeLocal({ registryMeta: { ...registryMeta, loadedAt: '2026-01-01T00:00:00.000Z' } });
    mock.fetchRoutes[REMOTE_REGISTRY_URL] = () =>
      jsonResponse(makeRegistry(REGISTRY.services, '2026-09-27T00:00:00.000Z'));
    await handleStartup();
    assert.equal(remoteCalls(), 1);
    assert.equal((await readLocal(['registryMeta'])).registryMeta.source, 'remote');
  });

  test('syncIfDue respects autoSync', async () => {
    await ensureReady();
    const { settings, registryMeta } = await readLocal(['settings', 'registryMeta']);
    await writeLocal({
      settings: { ...settings, autoSync: false },
      registryMeta: { ...registryMeta, loadedAt: '2026-01-01T00:00:00.000Z' },
    });
    assert.equal(await syncIfDue(), null);
    assert.equal(remoteCalls(), 0);
  });
});

describe('alarms', () => {
  beforeEach(async () => {
    await ensureReady();
  });

  test('weekly sync alarm fetches the registry when autoSync is on', async () => {
    await handleAlarm({ name: ALARMS.registrySync });
    assert.equal(remoteCalls(), 1);
    assert.equal((await readLocal(['registryMeta'])).registryMeta.lastSyncStatus, 'error');
    const { settings } = await readLocal(['settings']);
    await writeLocal({ settings: { ...settings, autoSync: false } });
    await handleAlarm({ name: ALARMS.registrySync, scheduledTime: Date.now() });
    assert.equal(remoteCalls(), 1);
  });

  test('daily reminder alarm creates due reminders and one notification', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    await writeLocal({
      userState: {
        services: {
          chatgpt: {
            tracked: true,
            source: 'manual',
            addedAt: old,
            knownPolicyVersion: 1,
            optOuts: { [TOGGLE]: { status: 'done', method: 'auto', updatedAt: old, verifiedAt: old } },
          },
        },
      },
    });
    await handleAlarm({ name: ALARMS.reminders });
    const { alerts } = await readLocal(['alerts']);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'reminder');
    assert.equal(mock.notifications.shown.size, 1);
    // Deduplicated on the next day.
    await checkReminders();
    assert.equal((await readLocal(['alerts'])).alerts.length, 1);
  });

  test('reminder notifications can be turned off', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    const { settings } = await readLocal(['settings']);
    await writeLocal({
      settings: { ...settings, notifications: { ...settings.notifications, reminders: false } },
      userState: {
        services: {
          chatgpt: {
            tracked: true,
            source: 'manual',
            addedAt: old,
            optOuts: { [TOGGLE]: { status: 'done', method: 'auto', updatedAt: old, verifiedAt: null } },
          },
        },
      },
    });
    const added = await checkReminders();
    assert.equal(added.length, 1);
    assert.equal(mock.notifications.shown.size, 0);
  });

  test('unknown alarms are ignored', async () => {
    await handleAlarm({ name: 'something-else' });
    assert.equal(remoteCalls(), 0);
  });
});

describe('storage reactions', () => {
  test('only local changes trigger work', async () => {
    await ensureReady();
    await handleStorageChanged({ runs: {} }, 'session');
    assert.equal(mock.action.badge.title, null);
    await handleStorageChanged({ alerts: {} }, 'local');
    assert.equal(mock.action.badge.title, 'NoTrain');
  });
});

describe('service-worker.js', () => {
  test('registers every listener synchronously at import and answers messages', async () => {
    await import('../../extension/background/service-worker.js');
    assert.equal(mock.runtime.onInstalled.size, 1);
    assert.equal(mock.runtime.onStartup.size, 1);
    assert.equal(mock.runtime.onMessage.size, 1);
    assert.equal(mock.alarms.onAlarm.size, 1);
    assert.equal(mock.storage.onChanged.size, 1);
    assert.equal(mock.permissions.onAdded.size, 1);
    assert.equal(mock.permissions.onRemoved.size, 1);
    assert.equal(mock.tabs.onRemoved.size, 1);
    assert.equal(mock.notifications.onClicked.size, 1);

    const response = await new Promise((resolve) => {
      const [keepOpen] = mock.runtime.onMessage.dispatch({ type: 'getState' }, senders.popup(), resolve);
      assert.equal(keepOpen, true, 'listener keeps the channel open for the async response');
    });
    assert.equal(response.ok, true);
    assert.equal(response.data.registry.services.length, 2);

    const rejected = await new Promise((resolve) => {
      mock.runtime.onMessage.dispatch(
        { type: 'resetAll' },
        senders.content(4, 'https://chatgpt.com/'),
        resolve,
      );
    });
    assert.equal(rejected.ok, false);

    // Permission grants are logged for detection clean-up.
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    await tick(10);
    assert.equal(mock.storage.session.dump().recentGrants.length, 1);

    // Notification clicks open the dashboard at the service.
    mock.notifications.onClicked.dispatch('notrain:flip_back:chatgpt:abcd1234');
    await tick(10);
    assert.equal(mock.tabs.created.at(-1).url, `${EXTENSION_BASE}dashboard/dashboard.html#/service/chatgpt`);
  });
});
