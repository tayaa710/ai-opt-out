import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_BASE, installChromeMock } from './helpers/chrome-mock.mjs';
import { TEST_MANIFEST, bumpPolicy, exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';
import {
  _resetIconCheck,
  dashboardRouteFor,
  handleNotificationClick,
  notificationId,
  notify,
  parseNotificationId,
} from '../../extension/lib/notify.js';
import { BADGE_COLOR, badgeText, computeBadgeCount, updateBadge } from '../../extension/lib/badge.js';
import { defaultSettings, writeLocal } from '../../extension/lib/storage.js';

let mock;
beforeEach(() => {
  _resetIconCheck();
  mock = installChromeMock({ manifest: TEST_MANIFEST });
});
afterEach(() => mock.uninstall());

describe('notifications', () => {
  test('ids encode the service and route clicks to it', () => {
    const id = notificationId('flip_back', 'chatgpt');
    assert.deepEqual(parseNotificationId(id), { kind: 'flip_back', serviceId: 'chatgpt' });
    assert.equal(dashboardRouteFor(id), '#/service/chatgpt');
    assert.equal(dashboardRouteFor(notificationId('reminder', null)), '#/alerts');
    assert.equal(dashboardRouteFor('notrain:x:../../evil:1'), '#/alerts');
    assert.equal(dashboardRouteFor('someone-else'), null);
    assert.equal(parseNotificationId(42), null);
  });

  test('uses the packaged icon', async () => {
    const id = await notify({ kind: 'flip_back', serviceId: 'chatgpt', title: 'T', message: 'M' });
    const opts = mock.notifications.shown.get(id);
    assert.equal(opts.iconUrl, `${EXTENSION_BASE}icons/icon-128.png`);
    assert.equal(opts.type, 'basic');
  });

  test('falls back to an embedded icon when the packaged one is missing', async () => {
    mock.iconExists = false;
    const id = await notify({ kind: 'reminder', title: 'T', message: 'M' });
    assert.match(mock.notifications.shown.get(id).iconUrl, /^data:image\/png;base64,/);
  });

  test('retries with the embedded icon when the browser cannot load the icon', async () => {
    mock.notifications.failIcon = true;
    const id = await notify({ kind: 'reminder', title: 'T', message: 'M' });
    assert.ok(id);
    assert.match(mock.notifications.shown.get(id).iconUrl, /^data:/);
  });

  test('never throws when notifications are unavailable', async () => {
    delete mock.notifications;
    assert.equal(await notify({ kind: 'reminder', title: 'T', message: 'M' }), null);
  });

  test('clicking opens the dashboard and clears the notification', async () => {
    const id = await notify({ kind: 'policy_change', serviceId: 'chatgpt', title: 'T', message: 'M' });
    await handleNotificationClick(id);
    assert.deepEqual(
      mock.tabs.created.map((t) => t.url),
      [`${EXTENSION_BASE}dashboard/dashboard.html#/service/chatgpt`],
    );
    assert.equal(mock.notifications.shown.has(id), false);
    await handleNotificationClick('not-ours');
    assert.equal(mock.tabs.created.length, 1);
  });
});

describe('badge', () => {
  const registry = makeRegistry([bumpPolicy(makeService()), exampleService()]);
  const settings = defaultSettings();
  const alert = (fields) => ({
    id: Math.random().toString(36),
    kind: 'flip_back',
    severity: 'warning',
    read: false,
    dismissed: false,
    createdAt: '2026-09-01T00:00:00Z',
    ...fields,
  });
  const svcState = (optOuts, known = 2) => ({
    tracked: true,
    source: 'manual',
    addedAt: '2026-09-01T00:00:00Z',
    knownPolicyVersion: known,
    optOuts,
  });

  test('counts a service needing attention once, even with an alert about it', () => {
    const userState = {
      services: {
        chatgpt: svcState({ 'improve-model-toggle': { status: 'needs_attention', method: 'auto' } }),
      },
    };
    const alerts = [alert({ serviceId: 'chatgpt' }), alert({ serviceId: 'chatgpt', kind: 'policy_change' })];
    assert.equal(computeBadgeCount({ registry, userState, settings, alerts }), 1);
  });

  test('pending important policy changes count; info, read and dismissed alerts do not', () => {
    const userState = { services: { chatgpt: svcState({}, 1) } };
    const alerts = [
      alert({ serviceId: 'example', severity: 'critical', kind: 'policy_change' }),
      alert({ serviceId: 'example' }),
      alert({ serviceId: null, severity: 'warning', kind: 'new_service' }),
      alert({ serviceId: 'x', severity: 'info', kind: 'reminder' }),
      alert({ serviceId: 'y', read: true }),
      alert({ serviceId: 'z', dismissed: true }),
    ];
    // chatgpt (pending policy change) + example (two alerts, counted once) + the service-less alert
    assert.equal(computeBadgeCount({ registry, userState, settings, alerts }), 3);
    assert.equal(computeBadgeCount({ registry: null, userState: { services: {} }, settings, alerts: [] }), 0);
  });

  test('badgeText', () => {
    assert.equal(badgeText(0), '');
    assert.equal(badgeText(7), '7');
    assert.equal(badgeText(150), '99+');
  });

  test('updateBadge sets text, colour and an accessible title, and clears at zero', async () => {
    await writeLocal({
      registry,
      userState: {
        services: {
          chatgpt: svcState({
            'improve-model-toggle': {
              status: 'needs_attention',
              method: 'auto',
              updatedAt: '2026-09-01T00:00:00Z',
            },
          }),
        },
      },
    });
    await updateBadge();
    assert.deepEqual(mock.action.badge, {
      text: '1',
      color: BADGE_COLOR,
      textColor: '#FFFFFF',
      title: 'NoTrain: 1 item needs attention',
    });
    await writeLocal({ userState: { services: {} } });
    await updateBadge();
    assert.equal(mock.action.badge.text, '');
    assert.equal(mock.action.badge.title, 'NoTrain');
  });

  test('updateBadge never throws', async () => {
    mock.action.setBadgeText = async () => {
      throw new Error('no action');
    };
    await updateBadge();
    delete mock.action;
    await updateBadge();
  });
});
