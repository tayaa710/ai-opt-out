import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, senders, tick } from './helpers/chrome-mock.mjs';
import { TEST_MANIFEST, bumpPolicy, exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';
import { ROUTES, classifySender, handleMessage } from '../../extension/background/router.js';
import { validateBackup } from '../../extension/background/validate.js';
import { ARCHITECTURE_MESSAGE_TYPES } from './helpers/contract.mjs';
import { _resetIconCheck } from '../../extension/lib/notify.js';
import { defaultSettings, writeLocal } from '../../extension/lib/storage.js';

const TOGGLE = 'improve-model-toggle';
const REGISTRY = makeRegistry([makeService(), exampleService()]);
let mock;

const ui = (msg) => handleMessage(msg, senders.popup());
async function ok(msg, sender = senders.popup()) {
  const res = await handleMessage(msg, sender);
  assert.equal(res.ok, true, `${msg?.type} failed: ${res.error}`);
  return res.data;
}
async function fails(msg, re, sender = senders.popup()) {
  const res = await handleMessage(msg, sender);
  assert.equal(res.ok, false, `${msg?.type} unexpectedly succeeded`);
  assert.equal(typeof res.error, 'string');
  if (re) assert.match(res.error, re);
  return res.error;
}

beforeEach(() => {
  _resetIconCheck();
  mock = installChromeMock({ manifest: TEST_MANIFEST, registry: REGISTRY });
});
afterEach(() => mock.uninstall());

describe('classifySender', () => {
  test('extension pages are "ui"; https top frames are "content"; everything else is rejected', () => {
    assert.equal(classifySender(senders.popup()), 'ui');
    assert.equal(classifySender(senders.dashboard()), 'ui');
    assert.equal(classifySender(senders.content(3, 'https://chatgpt.com/')), 'content');
    assert.equal(classifySender(senders.content(3, 'https://chatgpt.com/', 2)), null, 'sub-frames');
    assert.equal(classifySender(senders.content(3, 'http://chatgpt.com/')), null, 'non-https');
    assert.equal(classifySender({ ...senders.content(3, 'https://x.test/'), tab: undefined }), null);
    assert.equal(classifySender(senders.otherExtension()), null);
    assert.equal(classifySender(undefined), null);
    assert.equal(classifySender({ id: mock.runtime.id }), null);
  });
});

describe('routing', () => {
  test('implements every message type in ARCHITECTURE.md', () => {
    for (const type of ARCHITECTURE_MESSAGE_TYPES) assert.ok(Object.hasOwn(ROUTES, type), type);
  });

  test('rejects malformed and unknown messages', async () => {
    await fails(null, /Invalid message/);
    await fails('getState', /Invalid message/);
    await fails({ type: 42 }, /Invalid message/);
    await fails({ type: 'toString' }, /Unknown message type/);
    await fails({ type: '__proto__' }, /Unknown message type/);
    await fails({ type: 'launchMissiles' }, /Unknown message type/);
  });

  test('UI messages are refused from web pages and other extensions', async () => {
    await fails({ type: 'getState' }, /not allowed/, senders.content(3, 'https://chatgpt.com/'));
    await fails({ type: 'resetAll' }, /not allowed/, senders.otherExtension());
    await fails({ type: 'exportData' }, /not allowed/, null);
  });

  test('content-script messages are refused from extension pages', async () => {
    await fails({ type: 'runResult', runId: 'x', outcome: 'success' }, /not allowed/);
    await fails(
      { type: 'getPassiveChecks', url: 'https://chatgpt.com/' },
      /not allowed/,
      senders.dashboard(),
    );
  });

  test('internal errors become { ok: false } responses', async () => {
    mock.storage.local.get = async () => {
      throw new Error('disk on fire');
    };
    const res = await ui({ type: 'getState' });
    assert.equal(res.ok, false);
    assert.match(res.error, /disk on fire/);
  });
});

describe('state messages', () => {
  test('getState returns the bundled registry, defaults and the latest 100 history entries', async () => {
    const data = await ok({ type: 'getState' });
    assert.deepEqual(Object.keys(data).sort(), [
      'alerts',
      'history',
      'registry',
      'registryMeta',
      'settings',
      'userState',
    ]);
    assert.equal(data.registry.services.length, 2);
    assert.equal(data.registryMeta.source, 'bundled');
    assert.deepEqual(data.settings, defaultSettings());
    assert.deepEqual(data.userState, { services: {} });
    const history = Array.from({ length: 150 }, (_, i) => ({ id: `h${i}` }));
    await writeLocal({ history });
    assert.equal((await ok({ type: 'getState' })).history.length, 100);
  });

  test('updateSettings validates and deep-merges', async () => {
    const s = await ok({
      type: 'updateSettings',
      patch: { region: 'EU', notifications: { reminders: false } },
    });
    assert.equal(s.region, 'EU');
    assert.deepEqual(s.notifications, { policyChanges: true, flipBacks: true, reminders: false });
    await fails({ type: 'updateSettings', patch: { region: 'XX' } }, /region/);
    await fails({ type: 'updateSettings' }, /patch/);
    assert.equal((await ok({ type: 'getState' })).settings.region, 'EU');
  });

  test('trackServices validates ids and source', async () => {
    const u = await ok({
      type: 'trackServices',
      serviceIds: ['chatgpt', 'example'],
      tracked: true,
      source: 'manual',
    });
    assert.deepEqual(Object.keys(u.services).sort(), ['chatgpt', 'example']);
    const off = await ok({ type: 'trackServices', serviceIds: ['example'], tracked: false });
    assert.equal(off.services.example.tracked, false);
    await fails({ type: 'trackServices', serviceIds: ['nope'], tracked: true }, /Unknown service/);
    await fails({ type: 'trackServices', serviceIds: [], tracked: true }, /serviceIds/);
    await fails({ type: 'trackServices', serviceIds: ['Bad Id'], tracked: true }, /valid id/);
    await fails({ type: 'trackServices', serviceIds: ['chatgpt'], tracked: 'yes' }, /tracked/);
    await fails({ type: 'trackServices', serviceIds: ['chatgpt'], tracked: true, source: 'magic' }, /source/);
  });

  test('setOptOutStatus stores the status and a history entry', async () => {
    const u = await ok({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'done',
      method: 'manual',
      note: 'Did it on my phone',
    });
    assert.equal(u.services.chatgpt.optOuts[TOGGLE].status, 'done');
    assert.equal(u.services.chatgpt.tracked, true);
    const { history } = await ok({ type: 'getState' });
    assert.deepEqual(
      [history[0].action, history[0].outcome, history[0].detail],
      ['manual', 'done', 'Did it on my phone'],
    );
    await fails(
      { type: 'setOptOutStatus', serviceId: 'chatgpt', optOutId: 'nope', status: 'done', method: 'manual' },
      /Unknown opt-out/,
    );
    await fails(
      {
        type: 'setOptOutStatus',
        serviceId: 'chatgpt',
        optOutId: TOGGLE,
        status: 'finished',
        method: 'manual',
      },
      /status/,
    );
    await fails(
      {
        type: 'setOptOutStatus',
        serviceId: 'chatgpt',
        optOutId: TOGGLE,
        status: 'done',
        method: 'telepathy',
      },
      /method/,
    );
    await fails(
      {
        type: 'setOptOutStatus',
        serviceId: 'chatgpt',
        optOutId: TOGGLE,
        status: 'done',
        method: 'manual',
        note: 5,
      },
      /note/,
    );
  });

  test('acknowledgePolicy updates knownPolicyVersion and marks the policy alerts read', async () => {
    await ok({ type: 'trackServices', serviceIds: ['chatgpt'], tracked: true });
    const registry = makeRegistry([bumpPolicy(makeService()), exampleService()], '2026-09-10T00:00:00.000Z');
    await writeLocal({
      registry,
      alerts: [
        {
          id: 'p1',
          kind: 'policy_change',
          serviceId: 'chatgpt',
          severity: 'warning',
          title: 't',
          body: 'b',
          createdAt: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
        {
          id: 'f1',
          kind: 'flip_back',
          serviceId: 'chatgpt',
          severity: 'warning',
          title: 't',
          body: 'b',
          createdAt: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ],
    });
    const u = await ok({ type: 'acknowledgePolicy', serviceId: 'chatgpt' });
    assert.equal(u.services.chatgpt.knownPolicyVersion, 2);
    const { alerts } = await ok({ type: 'getState' });
    assert.deepEqual(
      alerts.map((a) => a.read),
      [true, false],
    );
    await fails({ type: 'acknowledgePolicy', serviceId: 'example' }, /not tracked/);
  });

  test('markAlert and markAllAlertsRead', async () => {
    const base = {
      kind: 'reminder',
      serviceId: 'chatgpt',
      severity: 'info',
      title: 't',
      body: 'b',
      createdAt: new Date().toISOString(),
      read: false,
      dismissed: false,
    };
    await writeLocal({
      alerts: [
        { ...base, id: 'a1' },
        { ...base, id: 'a2' },
      ],
    });
    const alerts = await ok({ type: 'markAlert', id: 'a1', patch: { dismissed: true } });
    assert.deepEqual(
      alerts.map((a) => [a.id, a.read, a.dismissed]),
      [
        ['a1', true, true],
        ['a2', false, false],
      ],
    );
    await fails({ type: 'markAlert', id: 'zzz', patch: { read: true } }, /Unknown alert/);
    await fails({ type: 'markAlert', id: 'a1', patch: { title: 'hacked' } }, /Cannot change/);
    await fails({ type: 'markAlert', id: 'a1' }, /patch/);
    const all = await ok({ type: 'markAllAlertsRead' });
    assert.ok(all.every((a) => a.read));
  });

  test('recordLetter marks the opt-out as sent by letter', async () => {
    const u = await ok({ type: 'recordLetter', serviceId: 'chatgpt', optOutId: 'privacy-portal' });
    assert.deepEqual(
      [
        u.services.chatgpt.optOuts['privacy-portal'].status,
        u.services.chatgpt.optOuts['privacy-portal'].method,
      ],
      ['sent', 'letter'],
    );
    const { history } = await ok({ type: 'getState' });
    assert.deepEqual([history[0].action, history[0].outcome], ['letter', 'sent']);
    await fails({ type: 'recordLetter', serviceId: 'chatgpt' }, /optOutId/);
  });

  test('runOptOut validates its payload and returns the run', async () => {
    await fails({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'yolo' }, /mode/);
    await fails({ type: 'runOptOut', serviceId: 'nope', optOutId: TOGGLE, mode: 'auto' }, /Unknown service/);
    const r = await ok({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.deepEqual([r.injected, r.reason], [false, 'no_permission']);
    assert.equal(typeof r.tabId, 'number');
  });

  test('detectAccounts without permission fails cleanly', async () => {
    await fails({ type: 'detectAccounts' }, /not granted/);
  });

  test('syncRegistry records errors instead of failing', async () => {
    const meta = await ok({ type: 'syncRegistry', force: true });
    assert.equal(meta.lastSyncStatus, 'error');
    await fails({ type: 'syncRegistry', force: 'yes' }, /force/);
  });

  test('probeWellKnown validates the tab id', async () => {
    await fails({ type: 'probeWellKnown', tabId: 'abc' }, /tabId/);
    const r = await ok({ type: 'probeWellKnown', tabId: 12345 });
    assert.deepEqual(r, { found: false, url: null, error: 'tab_not_found' });
  });
});

describe('content-script messages', () => {
  test('are routed to run and passive handlers', async () => {
    const sender = senders.content(5, 'https://chatgpt.com/');
    await fails({ type: 'runProgress', runId: 'nope', stepIndex: 0, total: 1 }, /Unknown run/, sender);
    await fails({ type: 'guidedDone', runId: 'nope' }, /Unknown run/, sender);
    assert.deepEqual(await ok({ type: 'getPassiveChecks', url: 'https://chatgpt.com/' }, sender), {
      checks: [],
    });
    await fails(
      { type: 'passiveCheckResult', serviceId: 'chatgpt', optOutId: TOGGLE, state: 'purple' },
      /state/,
      sender,
    );
    await fails(
      { type: 'passiveCheckResult', serviceId: 'chatgpt', optOutId: TOGGLE, state: 'on' },
      /No passive check/,
      sender,
    );
  });
});

describe('export / import / reset', () => {
  test('export → reset → import restores the same data', async () => {
    await ok({ type: 'updateSettings', patch: { region: 'UK', profile: { fullName: 'Ada' } } });
    await ok({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'done',
      method: 'manual',
    });
    const backup = await ok({ type: 'exportData' });
    assert.equal(backup.app, 'NoTrain');
    assert.equal(backup.schemaVersion, 1);
    assert.ok(backup.exportedAt);
    const json = JSON.parse(JSON.stringify(backup));

    assert.equal(await ok({ type: 'resetAll' }), true);
    const reset = await ok({ type: 'getState' });
    assert.deepEqual(reset.settings, defaultSettings());
    assert.deepEqual(reset.userState, { services: {} });
    assert.equal(reset.registry.services.length, 2, 'bundled registry is kept');

    const restored = await ok({ type: 'importData', data: json });
    assert.equal(restored.settings.region, 'UK');
    assert.equal(restored.userState.services.chatgpt.optOuts[TOGGLE].status, 'done');
    const after = await ok({ type: 'getState' });
    assert.deepEqual(after.userState, backup.userState);
    assert.deepEqual(after.history, backup.history);
  });

  test('resetAll clears passive registrations and session state, then reloads the bundled registry', async () => {
    await mock.scripting.registerContentScripts([
      { id: 'notrain-passive-chatgpt', matches: ['https://chatgpt.com/*'], js: ['x.js'] },
    ]);
    await mock.storage.session.set({ runs: { r: {} } });
    await writeLocal({
      registry: makeRegistry([makeService()], '2026-09-25T00:00:00.000Z'),
      registryMeta: { source: 'remote' },
    });
    await ok({ type: 'resetAll' });
    assert.equal(mock.scripting.registered.size, 0);
    assert.equal(mock.storage.session.dump().runs, undefined);
    const { registry, registryMeta } = await ok({ type: 'getState' });
    assert.equal(registry.generatedAt, REGISTRY.generatedAt);
    assert.equal(registryMeta.source, 'bundled');
  });

  test('importData rejects anything that is not a valid backup, leaving data untouched', async () => {
    await ok({ type: 'updateSettings', patch: { region: 'JP' } });
    const good = await ok({ type: 'exportData' });
    const bad = [
      [null, /JSON object/],
      [{ ...good, app: 'Other' }, /not a NoTrain backup/],
      [{ ...good, schemaVersion: 99 }, /newer version/],
      [{ ...good, settings: { ...good.settings, region: 'XX' } }, /settings: region/],
      [{ ...good, settings: { ...good.settings, evil: true } }, /Unknown setting/],
      [{ ...good, userState: { services: { chatgpt: { tracked: 'yes' } } } }, /tracked/],
      [{ ...good, userState: { services: { 'Bad Id': {} } } }, /valid id/],
      [{ ...good, userState: { services: {}, extra: 1 } }, /not a known field/],
      [{ ...good, alerts: [{ id: 'x' }] }, /alerts\[0\]/],
      [{ ...good, history: 'nope' }, /history must be a list/],
      [
        {
          ...good,
          history: [{ id: 'h', at: 'x', serviceId: 'a', optOutId: 'b', action: 'auto', outcome: 'success' }],
        },
        /history\[0\]\.at/,
      ],
    ];
    for (const [data, re] of bad) await fails({ type: 'importData', data }, re);
    assert.equal((await ok({ type: 'getState' })).settings.region, 'JP');
  });

  test('validateBackup accepts older exports without alerts/history and fills defaults', () => {
    const b = validateBackup({ app: 'NoTrain', settings: { region: 'EU' }, userState: { services: {} } });
    assert.equal(b.settings.region, 'EU');
    assert.equal(b.settings.reminderIntervalDays, 90);
    assert.deepEqual(b.alerts, []);
    assert.deepEqual(b.history, []);
  });
});

describe('badge follows state (via the storage listener in the service worker)', () => {
  test('flip-back shows a count', async () => {
    const { handleStorageChanged } = await import('../../extension/background/lifecycle.js');
    mock.storage.onChanged.addListener((c, a) => handleStorageChanged(c, a));
    await ok({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'needs_attention',
      method: 'auto',
    });
    await tick(10);
    assert.equal(mock.action.badge.text, '1');
    await ok({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'done',
      method: 'auto',
    });
    await tick(10);
    assert.equal(mock.action.badge.text, '');
  });
});
