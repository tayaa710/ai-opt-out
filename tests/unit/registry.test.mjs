import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, jsonResponse } from './helpers/chrome-mock.mjs';
import { TEST_MANIFEST, bumpPolicy, exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';
import {
  MIN_SYNC_INTERVAL_MS,
  REMOTE_MAX_BYTES,
  ensureRegistry,
  fetchJson,
  isSyncDue,
  isSyncStale,
  readTextCapped,
  refreshFromBundled,
  syncRegistry,
} from '../../extension/lib/registry.js';
import { REMOTE_REGISTRY_URL } from '../../extension/lib/constants.js';
import { migrateStorage, writeLocal } from '../../extension/lib/storage.js';
import { _resetIconCheck } from '../../extension/lib/notify.js';

const BUNDLED = makeRegistry([makeService(), exampleService()], '2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-09-28T12:00:00Z');

function trackChatgpt() {
  return writeLocal({
    userState: {
      services: {
        chatgpt: {
          tracked: true,
          source: 'manual',
          addedAt: '2026-09-01T00:00:00Z',
          knownPolicyVersion: 1,
          optOuts: {},
        },
      },
    },
  });
}

describe('bundled registry', () => {
  let mock;
  beforeEach(async () => {
    _resetIconCheck();
    mock = installChromeMock({ manifest: TEST_MANIFEST, registry: BUNDLED });
    await migrateStorage();
  });
  afterEach(() => mock.uninstall());

  test('ensureRegistry loads and caches the bundled copy once', async () => {
    const r = await ensureRegistry();
    assert.equal(r.services.length, 2);
    const dump = mock.storage.local.dump();
    assert.equal(dump.registry.generatedAt, BUNDLED.generatedAt);
    assert.equal(dump.registryMeta.source, 'bundled');
    assert.equal(dump.registryMeta.lastSyncStatus, null);
    const calls = mock.fetchCalls.length;
    await ensureRegistry();
    assert.equal(mock.fetchCalls.length, calls, 'no refetch when cached');
  });

  test('a missing bundled registry leaves an empty registry with an error, and is retried later', async () => {
    mock.registryBody = null;
    const r = await ensureRegistry();
    assert.deepEqual(r.services, []);
    assert.match(mock.storage.local.dump().registryMeta.lastError, /Bundled registry unavailable/);
    mock.registryBody = BUNDLED;
    const again = await ensureRegistry();
    assert.equal(again.services.length, 2);
  });

  test('after an update, a newer bundled registry replaces the cache and alerts tracked services', async () => {
    await ensureRegistry();
    await trackChatgpt();
    const svc = bumpPolicy(makeService(), 'critical', 'Started training on all chats by default.');
    mock.registryBody = makeRegistry([svc, exampleService()], '2026-09-20T00:00:00.000Z');
    await refreshFromBundled({ createAlerts: true, now: NOW });
    const dump = mock.storage.local.dump();
    assert.equal(dump.registry.generatedAt, '2026-09-20T00:00:00.000Z');
    assert.equal(dump.alerts.length, 1);
    assert.equal(dump.alerts[0].severity, 'critical');
    assert.equal(mock.notifications.shown.size, 1, 'critical change notifies');
  });

  test('an older bundled registry never replaces a newer (remote) cache', async () => {
    const remote = makeRegistry([makeService()], '2026-09-25T00:00:00.000Z');
    await writeLocal({
      registry: remote,
      registryMeta: { source: 'remote', generatedAt: remote.generatedAt },
    });
    await refreshFromBundled({ createAlerts: true });
    assert.equal(mock.storage.local.dump().registry.generatedAt, remote.generatedAt);
  });
});

describe('syncRegistry', () => {
  let mock;
  const serve = (body, init) => {
    mock.fetchRoutes[REMOTE_REGISTRY_URL] = () => jsonResponse(body, init);
  };
  beforeEach(async () => {
    _resetIconCheck();
    mock = installChromeMock({ manifest: TEST_MANIFEST, registry: BUNDLED });
    await migrateStorage();
    await ensureRegistry();
    await trackChatgpt();
  });
  afterEach(() => mock.uninstall());

  test('a newer valid registry replaces the cache and creates alerts + notifications', async () => {
    const newcomer = makeService({ id: 'newcomer', name: 'Newcomer' });
    serve(makeRegistry([bumpPolicy(makeService()), exampleService(), newcomer], '2026-09-27T00:00:00.000Z'));
    const meta = await syncRegistry({ force: true, now: NOW });
    assert.equal(meta.source, 'remote');
    assert.equal(meta.lastSyncStatus, 'ok');
    assert.equal(meta.generatedAt, '2026-09-27T00:00:00.000Z');
    assert.equal(meta.lastSyncAt, NOW.toISOString());
    const dump = mock.storage.local.dump();
    assert.equal(dump.registry.services.length, 3);
    assert.deepEqual(dump.alerts.map((a) => a.kind).sort(), ['new_service', 'policy_change']);
    assert.equal(mock.notifications.shown.size, 1, 'only the warning policy change notifies');
    const call = mock.fetchCalls.find((c) => c.url === REMOTE_REGISTRY_URL);
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
  });

  test('no notification when policy-change notifications are off', async () => {
    const { settings } = mock.storage.local.dump();
    await writeLocal({
      settings: { ...settings, notifications: { ...settings.notifications, policyChanges: false } },
    });
    serve(makeRegistry([bumpPolicy(makeService()), exampleService()], '2026-09-27T00:00:00.000Z'));
    await syncRegistry({ force: true, now: NOW });
    assert.equal(mock.storage.local.dump().alerts.length, 1);
    assert.equal(mock.notifications.shown.size, 0);
  });

  test('same or older generatedAt → unchanged, cache kept', async () => {
    serve(makeRegistry([bumpPolicy(makeService())], BUNDLED.generatedAt));
    const meta = await syncRegistry({ force: true, now: NOW });
    assert.equal(meta.lastSyncStatus, 'unchanged');
    assert.equal(meta.source, 'bundled');
    assert.equal(mock.storage.local.dump().registry.services[0].policyVersion, 1);
  });

  const failures = [
    [
      'offline',
      () => {
        mock.fetchRoutes[REMOTE_REGISTRY_URL] = () => Promise.reject(new TypeError('Failed to fetch'));
      },
      /Failed to fetch/,
    ],
    ['HTTP error', () => serve('nope', { status: 503 }), /HTTP 503/],
    ['invalid JSON', () => serve('{not json'), /not valid JSON/],
    ['unsupported format', () => serve({ ...makeRegistry(), formatVersion: 99 }), /formatVersion/],
    [
      'no valid services',
      () => serve(makeRegistry([{ id: 'x' }], '2026-09-27T00:00:00.000Z')),
      /no valid services/,
    ],
    [
      'declared too large',
      () => serve(makeRegistry(), { headers: { 'content-length': String(REMOTE_MAX_BYTES + 1) } }),
      /too large/,
    ],
  ];
  for (const [name, setup, re] of failures) {
    test(`${name} → lastSyncStatus error, registry untouched`, async () => {
      setup();
      const before = mock.storage.local.dump().registry;
      const meta = await syncRegistry({ force: true, now: NOW });
      assert.equal(meta.lastSyncStatus, 'error');
      assert.match(meta.lastError, re);
      assert.equal(meta.lastSyncAt, NOW.toISOString());
      assert.deepEqual(mock.storage.local.dump().registry, before);
    });
  }

  test('a body that grows past the cap is aborted while streaming', async () => {
    mock.fetchRoutes[REMOTE_REGISTRY_URL] = () => {
      const chunk = new Uint8Array(512 * 1024).fill(32);
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (sent >= 5) controller.close();
          else {
            sent += 1;
            controller.enqueue(chunk);
          }
        },
      });
      return new Response(body, { status: 200 });
    };
    const meta = await syncRegistry({ force: true, now: NOW });
    assert.match(meta.lastError, /too large/);
  });

  test('times out a request that never answers', async () => {
    mock.fetchRoutes[REMOTE_REGISTRY_URL] = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await assert.rejects(fetchJson(REMOTE_REGISTRY_URL, { timeoutMs: 20 }), /timed out/);
  });

  test('unforced syncs are throttled; concurrent syncs share one request', async () => {
    serve(makeRegistry([makeService(), exampleService()], '2026-09-27T00:00:00.000Z'));
    const [a, b] = await Promise.all([
      syncRegistry({ force: true, now: NOW }),
      syncRegistry({ force: true, now: NOW }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(mock.fetchCalls.filter((c) => c.url === REMOTE_REGISTRY_URL).length, 1);
    const soon = new Date(NOW.getTime() + MIN_SYNC_INTERVAL_MS / 2);
    await syncRegistry({ force: false, now: soon });
    assert.equal(mock.fetchCalls.filter((c) => c.url === REMOTE_REGISTRY_URL).length, 1);
    await syncRegistry({ force: true, now: soon });
    assert.equal(mock.fetchCalls.filter((c) => c.url === REMOTE_REGISTRY_URL).length, 2);
  });
});

describe('staleness', () => {
  const week = 7 * 86_400_000;
  test('isSyncStale uses the last success (or the bundled load time)', () => {
    assert.equal(isSyncStale(null, NOW), true);
    assert.equal(isSyncStale({ loadedAt: new Date(NOW - week + 1000).toISOString() }, NOW), false);
    assert.equal(isSyncStale({ lastSuccessAt: new Date(NOW - week - 1).toISOString() }, NOW), true);
  });

  test('isSyncDue backs off after a recent failed attempt', () => {
    const stale = new Date(NOW - 2 * week).toISOString();
    assert.equal(
      isSyncDue({ lastSuccessAt: stale, lastSyncAt: new Date(NOW - 60_000).toISOString() }, NOW),
      false,
    );
    assert.equal(
      isSyncDue({ lastSuccessAt: stale, lastSyncAt: new Date(NOW - 7 * 3600_000).toISOString() }, NOW),
      true,
    );
    assert.equal(isSyncDue({ lastSuccessAt: NOW.toISOString() }, NOW), false);
  });
});

describe('readTextCapped', () => {
  test('reads bodies without a stream reader', async () => {
    const fake = { headers: new Headers(), body: null, text: async () => 'hello' };
    assert.equal(await readTextCapped(fake, 10), 'hello');
    await assert.rejects(readTextCapped(fake, 2), /too large/);
  });
});
