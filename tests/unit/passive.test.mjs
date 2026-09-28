import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, senders } from './helpers/chrome-mock.mjs';
import {
  TEST_MANIFEST,
  exampleService,
  formOptOut,
  makeRegistry,
  makeService,
  toggleOptOut,
} from './helpers/fixtures.mjs';
import {
  PASSIVE_FILES,
  PASSIVE_PREFIX,
  expectedToggleState,
  getPassiveChecks,
  handlePassiveResult,
  passiveCandidates,
  syncPassiveRegistrations,
  unregisterAllPassive,
} from '../../extension/lib/passive.js';
import { defaultSettings, migrateStorage, readLocal, writeLocal } from '../../extension/lib/storage.js';
import { ensureRegistry } from '../../extension/lib/registry.js';
import { _resetIconCheck } from '../../extension/lib/notify.js';

const TOGGLE = 'improve-model-toggle';
const REGISTRY = makeRegistry([makeService(), exampleService()]);
const doneRec = (verifiedAt = null) => ({
  status: 'done',
  method: 'auto',
  updatedAt: '2026-09-01T00:00:00.000Z',
  verifiedAt,
});
const stateWith = (optOuts, tracked = true, extra = {}) => ({
  services: {
    chatgpt: {
      tracked,
      source: 'manual',
      addedAt: '2026-09-01T00:00:00.000Z',
      knownPolicyVersion: 1,
      optOuts,
    },
    ...extra,
  },
});

let mock;
async function setup(userState) {
  _resetIconCheck();
  mock = installChromeMock({ manifest: TEST_MANIFEST, registry: REGISTRY });
  await migrateStorage();
  await ensureRegistry();
  if (userState) await writeLocal({ userState });
}
afterEach(() => mock?.uninstall());

describe('expectedToggleState / passiveCandidates', () => {
  test('desired state comes from the last assertToggle, else setToggle, else off', () => {
    assert.equal(expectedToggleState(toggleOptOut()), 'off');
    const on = toggleOptOut();
    on.automation.verify = [{ action: 'assertToggle', target: { role: 'switch' }, state: 'on' }];
    assert.equal(expectedToggleState(on), 'on');
    const stepsOnly = toggleOptOut();
    stepsOnly.automation.verify = [{ action: 'waitFor', target: { role: 'switch' } }];
    stepsOnly.automation.steps = [{ action: 'setToggle', target: { role: 'switch' }, state: 'on' }];
    assert.equal(expectedToggleState(stepsOnly), 'on');
    assert.equal(expectedToggleState(formOptOut()), 'off');
  });

  test('only tracked services with a done toggle that has verify steps and declared hosts', () => {
    const declared = TEST_MANIFEST.optional_host_permissions;
    const settings = defaultSettings();
    const base = { registry: REGISTRY, settings };
    assert.equal(
      passiveCandidates({ ...base, userState: stateWith({ [TOGGLE]: doneRec() }) }, declared).size,
      1,
    );
    assert.equal(
      passiveCandidates({ ...base, userState: stateWith({ [TOGGLE]: doneRec() }, false) }, declared).size,
      0,
    );
    assert.equal(
      passiveCandidates({ ...base, userState: stateWith({ 'privacy-portal': doneRec() }) }, declared).size,
      0,
    );
    assert.equal(
      passiveCandidates(
        { ...base, userState: stateWith({ [TOGGLE]: { ...doneRec(), status: 'sent' } }) },
        declared,
      ).size,
      0,
    );
    assert.equal(
      passiveCandidates(
        {
          registry: REGISTRY,
          settings: { ...settings, passiveChecks: false },
          userState: stateWith({ [TOGGLE]: doneRec() }),
        },
        declared,
      ).size,
      0,
    );
    assert.equal(passiveCandidates({ ...base, userState: stateWith({ [TOGGLE]: doneRec() }) }, []).size, 0);
  });
});

describe('syncPassiveRegistrations', () => {
  beforeEach(() => setup(stateWith({ [TOGGLE]: doneRec() })));

  test('registers only when the host permission is granted', async () => {
    await syncPassiveRegistrations();
    assert.equal(mock.scripting.registered.size, 0);
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await syncPassiveRegistrations();
    const s = mock.scripting.registered.get(`${PASSIVE_PREFIX}chatgpt`);
    assert.deepEqual(s.matches, ['https://chatgpt.com/*']);
    assert.deepEqual(s.js, [...PASSIVE_FILES]);
    assert.equal(s.persistAcrossSessions, true);
    assert.equal(s.allFrames, false);
  });

  test('is idempotent and unregisters when no longer needed', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await syncPassiveRegistrations();
    await syncPassiveRegistrations();
    assert.equal(mock.scripting.registered.size, 1);
    const { settings } = await readLocal(['settings']);
    await writeLocal({ settings: { ...settings, passiveChecks: false } });
    await syncPassiveRegistrations();
    assert.equal(mock.scripting.registered.size, 0);
  });

  test('unregisters when the permission is revoked, keeps unrelated scripts', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await mock.scripting.registerContentScripts([
      { id: 'someone-else', matches: ['https://x.test/*'], js: ['a.js'] },
    ]);
    await syncPassiveRegistrations();
    await mock.permissions.remove({ origins: ['https://chatgpt.com/*'] });
    await syncPassiveRegistrations();
    assert.deepEqual([...mock.scripting.registered.keys()], ['someone-else']);
  });

  test('re-registers when the matches change', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await mock.scripting.registerContentScripts([
      { id: `${PASSIVE_PREFIX}chatgpt`, matches: ['https://old.chatgpt.com/*'], js: [...PASSIVE_FILES] },
    ]);
    await syncPassiveRegistrations();
    assert.deepEqual(mock.scripting.registered.get(`${PASSIVE_PREFIX}chatgpt`).matches, [
      'https://chatgpt.com/*',
    ]);
  });

  test('falls back when persistAcrossSessions is rejected (older Firefox)', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    mock.scripting.rejectPersist = true;
    await syncPassiveRegistrations();
    assert.equal(mock.scripting.registered.get(`${PASSIVE_PREFIX}chatgpt`).persistAcrossSessions, false);
  });

  test('a missing content script file is logged, not thrown', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    mock.scripting.missingFiles = ['content/passive-check.js'];
    await syncPassiveRegistrations();
    assert.equal(mock.scripting.registered.size, 0);
  });

  test('concurrent calls coalesce', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await Promise.all([syncPassiveRegistrations(), syncPassiveRegistrations(), syncPassiveRegistrations()]);
    assert.equal(mock.scripting.registered.size, 1);
  });

  test('unregisterAllPassive removes only NoTrain passive scripts', async () => {
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    await syncPassiveRegistrations();
    await mock.scripting.registerContentScripts([
      { id: 'other', matches: ['https://x.test/*'], js: ['a.js'] },
    ]);
    await unregisterAllPassive();
    assert.deepEqual([...mock.scripting.registered.keys()], ['other']);
  });
});

describe('getPassiveChecks / passiveCheckResult', () => {
  const page = () => senders.content(55, 'https://chatgpt.com/c/123');
  beforeEach(async () => {
    await setup(stateWith({ [TOGGLE]: doneRec('2026-09-01T00:00:00.000Z') }));
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
  });

  test('returns the verify steps for the page host only (from sender.url, not the payload)', async () => {
    const r = await getPassiveChecks({ url: 'https://evil.test/' }, page());
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].serviceId, 'chatgpt');
    assert.equal(r.checks[0].optOutId, TOGGLE);
    assert.equal(r.checks[0].expected, 'off');
    assert.ok(r.checks[0].verify.some((s) => s.action === 'assertToggle'));
    const none = await getPassiveChecks(
      { url: 'https://chatgpt.com/' },
      senders.content(55, 'https://app.example.org/'),
    );
    assert.deepEqual(none.checks, []);
  });

  test('no checks without the host permission', async () => {
    await mock.permissions.remove({ origins: ['https://chatgpt.com/*'] });
    assert.deepEqual((await getPassiveChecks({}, page())).checks, []);
  });

  test('state "on" for a toggle that should be off → needs_attention, alert, notification, history', async () => {
    const r = await handlePassiveResult({ serviceId: 'chatgpt', optOutId: TOGGLE, state: 'on' }, page());
    assert.deepEqual(r, { recorded: true });
    const { userState, alerts, history } = await readLocal(['userState', 'alerts', 'history']);
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].status, 'needs_attention');
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].method, 'auto');
    assert.equal(alerts[0].kind, 'flip_back');
    assert.equal(history[0].action, 'passive');
    assert.equal(history[0].outcome, 'mismatch');
    assert.equal(mock.notifications.shown.size, 1);

    // A second report no longer applies (status is not done any more).
    await assert.rejects(
      handlePassiveResult({ serviceId: 'chatgpt', optOutId: TOGGLE, state: 'on' }, page()),
    );
    assert.equal((await readLocal(['alerts'])).alerts.length, 1);
  });

  test('state "off" refreshes verifiedAt (throttled); "unknown" changes nothing', async () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    await handlePassiveResult({ serviceId: 'chatgpt', optOutId: TOGGLE, state: 'off' }, page(), { now });
    let rec = (await readLocal(['userState'])).userState.services.chatgpt.optOuts[TOGGLE];
    assert.equal(rec.verifiedAt, now.toISOString());
    assert.equal(rec.status, 'done');
    const soon = new Date(now.getTime() + 60_000);
    await handlePassiveResult({ serviceId: 'chatgpt', optOutId: TOGGLE, state: 'off' }, page(), {
      now: soon,
    });
    rec = (await readLocal(['userState'])).userState.services.chatgpt.optOuts[TOGGLE];
    assert.equal(rec.verifiedAt, now.toISOString());
    const r = await handlePassiveResult({ serviceId: 'chatgpt', optOutId: TOGGLE, state: 'unknown' }, page());
    assert.deepEqual(r, { recorded: false });
    assert.deepEqual((await readLocal(['history'])).history, []);
  });

  test('results from a host not registered for that service are rejected', async () => {
    await assert.rejects(
      handlePassiveResult(
        { serviceId: 'chatgpt', optOutId: TOGGLE, state: 'on' },
        senders.content(1, 'https://evil.test/'),
      ),
      /No passive check/,
    );
    await assert.rejects(
      handlePassiveResult({ serviceId: 'example', optOutId: 'ai-toggle', state: 'on' }, page()),
      /No passive check/,
    );
    const { userState } = await readLocal(['userState']);
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].status, 'done');
  });
});
