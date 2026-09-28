import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.mjs';
import {
  UserError,
  applySettingsPatch,
  defaultSettings,
  migrate,
  migrateStorage,
  normalizeSettings,
  normalizeUserState,
  readLocal,
  readSession,
  serialize,
  updateLocal,
  updateSession,
  writeLocal,
  clearAll,
} from '../../extension/lib/storage.js';
import {
  ALERTS_LIMIT,
  DEFAULT_SETTINGS,
  HISTORY_LIMIT,
  STORAGE_SCHEMA_VERSION,
} from '../../extension/lib/constants.js';

describe('settings normalisation', () => {
  test('defaults are a mutable deep copy of DEFAULT_SETTINGS', () => {
    const d = defaultSettings();
    assert.deepEqual(d, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    d.notifications.reminders = false;
    d.profile.email = 'x@y.z';
    assert.equal(DEFAULT_SETTINGS.notifications.reminders, true);
    assert.equal(defaultSettings().profile.email, '');
  });

  test('keeps valid fields, repairs invalid ones and drops unknown ones', () => {
    const s = normalizeSettings({
      region: 'EU',
      onboarded: 'yes',
      reminderIntervalDays: 3,
      autoSync: false,
      notifications: { policyChanges: false, reminders: 'no', bogus: true },
      profile: { fullName: 'Ada', email: 42 },
      extra: 1,
    });
    assert.equal(s.region, 'EU');
    assert.equal(s.onboarded, false);
    assert.equal(s.reminderIntervalDays, 90);
    assert.equal(s.autoSync, false);
    assert.deepEqual(s.notifications, { policyChanges: false, flipBacks: true, reminders: true });
    assert.deepEqual(s.profile, { fullName: 'Ada', email: '' });
    assert.equal('extra' in s, false);
    assert.equal(s.schemaVersion, STORAGE_SCHEMA_VERSION);
  });

  test('non-objects become defaults', () => {
    assert.deepEqual(normalizeSettings(null), defaultSettings());
    assert.deepEqual(normalizeSettings([1, 2]), defaultSettings());
  });
});

describe('applySettingsPatch', () => {
  test('merges notifications and profile one level deep', () => {
    const base = defaultSettings();
    const next = applySettingsPatch(base, {
      region: 'UK',
      notifications: { flipBacks: false },
      profile: { fullName: '  Ada Lovelace ' },
    });
    assert.equal(next.region, 'UK');
    assert.deepEqual(next.notifications, { policyChanges: true, flipBacks: false, reminders: true });
    assert.deepEqual(next.profile, { fullName: 'Ada Lovelace', email: '' });
    assert.equal(base.region, 'OTHER', 'input is not mutated');
  });

  test('accepts every documented setting', () => {
    const next = applySettingsPatch(defaultSettings(), {
      onboarded: true,
      reminderIntervalDays: 30,
      autoSync: false,
      passiveChecks: false,
      profile: { email: 'ada@example.org' },
    });
    assert.equal(next.onboarded, true);
    assert.equal(next.reminderIntervalDays, 30);
    assert.equal(next.autoSync, false);
    assert.equal(next.passiveChecks, false);
    assert.equal(next.profile.email, 'ada@example.org');
  });

  const invalid = [
    [{ bogus: 1 }, /Unknown setting/],
    [{ schemaVersion: 5 }, /Unknown setting/],
    [{ region: 'Mars' }, /region/],
    [{ onboarded: 'true' }, /boolean/],
    [{ reminderIntervalDays: 1 }, /reminderIntervalDays/],
    [{ reminderIntervalDays: 30.5 }, /reminderIntervalDays/],
    [{ notifications: { flipBacks: 1 } }, /boolean/],
    [{ notifications: { spam: true } }, /Unknown notification/],
    [{ notifications: 'off' }, /object/],
    [{ profile: { email: 'not-an-email' } }, /email/],
    [{ profile: { fullName: 'x'.repeat(201) } }, /at most/],
    [{ profile: { address: 'x' } }, /Unknown profile/],
  ];
  for (const [patch, re] of invalid) {
    test(`rejects ${JSON.stringify(patch).slice(0, 60)}`, () => {
      assert.throws(
        () => applySettingsPatch(defaultSettings(), patch),
        (err) => err instanceof UserError && re.test(err.message),
      );
    });
  }

  test('rejects a non-object patch', () => {
    assert.throws(() => applySettingsPatch(defaultSettings(), null), UserError);
    assert.throws(() => applySettingsPatch(defaultSettings(), ['region']), UserError);
  });

  test('an empty email is allowed (clears the field)', () => {
    const s = applySettingsPatch(
      { ...defaultSettings(), profile: { fullName: '', email: 'a@b.co' } },
      { profile: { email: '' } },
    );
    assert.equal(s.profile.email, '');
  });
});

describe('userState normalisation', () => {
  test('drops invalid ids and records, repairs fields', () => {
    const u = normalizeUserState({
      services: {
        chatgpt: {
          tracked: true,
          source: 'weird',
          addedAt: 'nope',
          knownPolicyVersion: 2,
          optOuts: {
            'improve-model-toggle': {
              status: 'done',
              method: 'auto',
              updatedAt: '2026-01-01T00:00:00.000Z',
              verifiedAt: 5,
            },
            'bad status': { status: 'done' },
            other: { status: 'exploded' },
          },
        },
        'Not An Id': { tracked: true },
        broken: 'string',
      },
    });
    assert.deepEqual(Object.keys(u.services), ['chatgpt']);
    const rec = u.services.chatgpt;
    assert.equal(rec.source, 'manual');
    assert.equal(rec.addedAt, new Date(0).toISOString());
    assert.equal(rec.knownPolicyVersion, 2);
    assert.deepEqual(Object.keys(rec.optOuts), ['improve-model-toggle']);
    assert.equal(rec.optOuts['improve-model-toggle'].verifiedAt, null);
  });

  test('garbage becomes an empty state', () => {
    assert.deepEqual(normalizeUserState(undefined), { services: {} });
    assert.deepEqual(normalizeUserState({ services: [] }), { services: {} });
  });
});

describe('migrate', () => {
  test('fresh install gets defaults at the current version', () => {
    const { data, fromVersion } = migrate({});
    assert.equal(fromVersion, STORAGE_SCHEMA_VERSION);
    assert.deepEqual(data.settings, defaultSettings());
    assert.deepEqual(data.userState, { services: {} });
    assert.deepEqual(data.alerts, []);
    assert.deepEqual(data.history, []);
  });

  test('unversioned (pre-release) data is treated as version 0 and upgraded', () => {
    const { data, fromVersion } = migrate({
      settings: { region: 'EU' },
      userState: {
        services: { x: { tracked: true, source: 'manual', addedAt: '2026-01-01T00:00:00Z', optOuts: {} } },
      },
    });
    assert.equal(fromVersion, 0);
    assert.equal(data.settings.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(data.settings.region, 'EU');
    assert.equal(data.userState.services.x.tracked, true);
  });

  test('caps alerts and history and drops malformed entries', () => {
    const alerts = Array.from({ length: ALERTS_LIMIT + 10 }, (_, i) => ({ id: `a${i}` }));
    const history = [...Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({ id: `h${i}` })), 'junk'];
    const { data } = migrate({ settings: { schemaVersion: 1 }, alerts: [null, ...alerts], history });
    assert.equal(data.alerts.length, ALERTS_LIMIT);
    assert.equal(data.alerts[0].id, 'a0');
    assert.equal(data.history.length, HISTORY_LIMIT);
  });

  test('data from a newer schema is normalised rather than rejected', () => {
    const { data, fromVersion } = migrate({ settings: { schemaVersion: 99, region: 'JP', futureField: 1 } });
    assert.equal(fromVersion, 99);
    assert.equal(data.settings.region, 'JP');
    assert.equal(data.settings.schemaVersion, STORAGE_SCHEMA_VERSION);
  });
});

describe('storage with chrome.storage', () => {
  let mock;
  beforeEach(() => {
    mock = installChromeMock();
  });
  afterEach(() => mock.uninstall());

  test('readLocal fills defaults for missing keys', async () => {
    const s = await readLocal();
    assert.deepEqual(s.settings, defaultSettings());
    assert.deepEqual(s.userState, { services: {} });
    assert.deepEqual(s.alerts, []);
    assert.equal(s.registry, null);
    assert.equal(s.registryMeta, null);
  });

  test('migrateStorage writes defaults on first run and is a no-op afterwards', async () => {
    const first = await migrateStorage();
    assert.deepEqual(first.changed.sort(), ['alerts', 'history', 'settings', 'userState']);
    const writes = mock.storage.local.writes;
    const second = await migrateStorage();
    assert.deepEqual(second.changed, []);
    assert.equal(mock.storage.local.writes, writes);
  });

  test('migrateStorage repairs corrupted data in place', async () => {
    await mock.storage.local.set({ settings: { schemaVersion: 1, region: 'nowhere' }, alerts: 'oops' });
    await migrateStorage();
    const dump = mock.storage.local.dump();
    assert.equal(dump.settings.region, 'OTHER');
    assert.deepEqual(dump.alerts, []);
  });

  test('concurrent updateLocal calls never lose updates', async () => {
    await writeLocal({ history: [] });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        updateLocal(['history'], (v) => ({ set: { history: [...v.history, { id: `e${i}` }] } })),
      ),
    );
    const { history } = await readLocal(['history']);
    assert.equal(history.length, 25);
  });

  test('a throwing mutator rejects without writing and without blocking the queue', async () => {
    await assert.rejects(
      updateLocal(['settings'], () => {
        throw new UserError('nope');
      }),
      /nope/,
    );
    assert.equal(mock.storage.local.writes, 0);
    const r = await updateLocal(['settings'], (v) => ({
      set: { settings: { ...v.settings, region: 'EU' } },
      result: 1,
    }));
    assert.equal(r, 1);
    assert.equal(mock.storage.local.dump().settings.region, 'EU');
  });

  test('serialize runs tasks in order even after a failure', async () => {
    const order = [];
    const a = serialize(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('a');
      throw new Error('a failed');
    });
    const b = serialize(async () => order.push('b'));
    await assert.rejects(a);
    await b;
    assert.deepEqual(order, ['a', 'b']);
  });

  test('updateSession stores values in chrome.storage.session', async () => {
    const r = await updateSession('runs', {}, (runs) => ({ value: { ...runs, x: 1 }, result: 'done' }));
    assert.equal(r, 'done');
    assert.deepEqual(await readSession('runs', {}), { x: 1 });
    assert.deepEqual(mock.storage.session.dump(), { runs: { x: 1 } });
    assert.deepEqual(mock.storage.local.dump(), {});
  });

  test('session falls back to memory when storage.session is unavailable (old Firefox)', async () => {
    delete mock.storage.session;
    await updateSession('runs', {}, () => ({ value: { y: 2 } }));
    assert.deepEqual(await readSession('runs', {}), { y: 2 });
    await clearAll();
    assert.deepEqual(await readSession('runs', {}), {});
  });

  test('clearAll wipes local and session storage', async () => {
    await writeLocal({ settings: { region: 'EU' } });
    await updateSession('runs', {}, () => ({ value: { a: 1 } }));
    await clearAll();
    assert.deepEqual(mock.storage.local.dump(), {});
    assert.deepEqual(mock.storage.session.dump(), {});
  });
});
