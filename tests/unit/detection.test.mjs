import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, tick } from './helpers/chrome-mock.mjs';
import {
  TEST_MANIFEST,
  exampleService,
  makeRegistry,
  makeService,
  rogueService,
} from './helpers/fixtures.mjs';
import {
  GRANT_WINDOW_MS,
  detectAccounts,
  newlyGrantedOrigins,
  recordPermissionGrant,
  recordPermissionRemoval,
} from '../../extension/lib/detection.js';
import {
  migrateStorage,
  readLocal,
  readSession,
  updateSession,
  writeLocal,
} from '../../extension/lib/storage.js';
import { ensureRegistry } from '../../extension/lib/registry.js';

const REGISTRY = makeRegistry([makeService(), exampleService(), rogueService()]);
const SECRET = 'super-secret-session-value';
let mock;

async function setup(options = {}) {
  mock = installChromeMock({
    manifest: TEST_MANIFEST,
    registry: REGISTRY,
    cookies: [
      { url: 'https://chatgpt.com', name: 'session-token', value: SECRET },
      { url: 'https://evil.test', name: 'sid', value: SECRET },
    ],
    ...options,
  });
  // The service worker wires permissions.onAdded/onRemoved like this.
  mock.permissions.onAdded.addListener((p) => recordPermissionGrant(p));
  mock.permissions.onRemoved.addListener((p) => recordPermissionRemoval(p));
  await migrateStorage();
  await ensureRegistry();
}
afterEach(() => mock?.uninstall());

describe('detectAccounts', () => {
  beforeEach(() => setup());

  test('fails without the cookies permission', async () => {
    await assert.rejects(detectAccounts({ grantWaitMs: 5 }), /not granted/);
  });

  test('tracks services with a sign-in cookie, then drops cookies + origins granted for detection', async () => {
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*', 'https://app.example.org/*'] });
    await tick();
    const r = await detectAccounts({ grantWaitMs: 5 });
    assert.deepEqual(r, { detected: ['chatgpt'], checked: 2 });

    const { userState } = await readLocal(['userState']);
    assert.equal(userState.services.chatgpt.tracked, true);
    assert.equal(userState.services.chatgpt.source, 'detected');
    assert.equal(userState.services.example, undefined);

    assert.equal(mock.granted.permissions.has('cookies'), false);
    assert.equal(mock.granted.origins.size, 0);
    await tick();
    assert.deepEqual(await readSession('recentGrants', []), []);
  });

  test('origins granted before detection (e.g. for one-click opt-outs) are kept', async () => {
    mock.grant({ origins: ['https://chatgpt.com/*'] }); // earlier, for a run
    await tick();
    // Age that grant so it is outside the detection window.
    await updateSession('recentGrants', [], (log) => ({
      value: log.map((e) => ({ ...e, at: e.at - GRANT_WINDOW_MS - 1000 })),
    }));
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*', 'https://app.example.org/*'] });
    await tick();
    const r = await detectAccounts({ grantWaitMs: 5 });
    assert.deepEqual(r.detected, ['chatgpt']);
    assert.deepEqual([...mock.granted.origins], ['https://chatgpt.com/*']);
    assert.equal(mock.granted.permissions.has('cookies'), false);
  });

  test('an origin granted moments before detection but in a separate grant is kept', async () => {
    mock.grant({ origins: ['https://chatgpt.com/*'] });
    mock.grant({ permissions: ['cookies'], origins: ['https://app.example.org/*'] });
    await tick();
    await detectAccounts({ grantWaitMs: 5 });
    assert.deepEqual([...mock.granted.origins], ['https://chatgpt.com/*']);
  });

  test('waits for a permissions.onAdded event that arrives after the message', async () => {
    mock.preGrant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    const p = detectAccounts({ grantWaitMs: 1000 });
    await tick(10);
    await recordPermissionGrant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    const r = await p;
    assert.deepEqual(r.detected, ['chatgpt']);
    assert.equal(mock.granted.origins.has('https://chatgpt.com/*'), false);
  });

  test('never reads undeclared hosts and never stores cookie values', async () => {
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    mock.preGrant({ origins: ['https://evil.test/*'] });
    await tick();
    const r = await detectAccounts({ grantWaitMs: 5 });
    assert.deepEqual(r.detected, ['chatgpt'], 'rogue service with an undeclared cookie host is not checked');
    const everything = JSON.stringify([mock.storage.local.dump(), mock.storage.session.dump()]);
    assert.equal(everything.includes(SECRET), false);
  });

  test('keeps an already tracked service as manual', async () => {
    await writeLocal({
      userState: {
        services: {
          chatgpt: {
            tracked: true,
            source: 'manual',
            addedAt: '2026-01-01T00:00:00.000Z',
            knownPolicyVersion: 1,
            optOuts: {},
          },
        },
      },
    });
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    await tick();
    await detectAccounts({ grantWaitMs: 5 });
    const { userState } = await readLocal(['userState']);
    assert.equal(userState.services.chatgpt.source, 'manual');
    assert.equal(userState.services.chatgpt.addedAt, '2026-01-01T00:00:00.000Z');
  });

  test('permissions are dropped even if detection fails half-way', async () => {
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    await tick();
    mock.cookies.get = async () => {
      throw new Error('cookie store exploded');
    };
    const r = await detectAccounts({ grantWaitMs: 5 });
    assert.deepEqual(r.detected, []);
    assert.equal(mock.granted.permissions.has('cookies'), false);
    assert.equal(mock.granted.origins.size, 0);
  });

  test('origins used by a run in progress are not removed', async () => {
    await updateSession('runs', {}, () => ({
      value: {
        r1: {
          runId: 'r1',
          phase: 'running',
          patterns: ['https://chatgpt.com/*'],
          startedAt: new Date().toISOString(),
        },
      },
    }));
    mock.grant({ permissions: ['cookies'], origins: ['https://chatgpt.com/*'] });
    await tick();
    await detectAccounts({ grantWaitMs: 5 });
    assert.equal(mock.granted.origins.has('https://chatgpt.com/*'), true);
  });
});

describe('grant log', () => {
  test('newlyGrantedOrigins prefers the grant that carried the cookies permission', () => {
    const now = 1_000_000;
    const log = [
      { at: now - 500, permissions: [], origins: ['https://a.test/*'] },
      { at: now - 100, permissions: ['cookies'], origins: ['https://b.test/*'] },
      { at: now - GRANT_WINDOW_MS - 1, permissions: ['cookies'], origins: ['https://old.test/*'] },
    ];
    assert.deepEqual(newlyGrantedOrigins(log, now), ['https://b.test/*']);
    assert.deepEqual(newlyGrantedOrigins(log.slice(0, 1), now), ['https://a.test/*']);
    assert.deepEqual(newlyGrantedOrigins('garbage', now), []);
  });

  test('removals are reflected in the log', async () => {
    mock = installChromeMock({ manifest: TEST_MANIFEST });
    await recordPermissionGrant({
      permissions: ['cookies'],
      origins: ['https://a.test/*', 'https://b.test/*'],
    });
    await recordPermissionRemoval({ permissions: ['cookies'], origins: ['https://a.test/*'] });
    const log = await readSession('recentGrants', []);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].permissions, []);
    assert.deepEqual(log[0].origins, ['https://b.test/*']);
  });
});
