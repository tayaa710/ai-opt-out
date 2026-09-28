import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueReminders,
  flipBackAlert,
  makeAlert,
  markAlert,
  markAllRead,
  markPolicyAlertsRead,
  maxSeverity,
  mergeAlerts,
} from '../../extension/lib/alerts.js';
import { appendHistory, makeHistoryEntry } from '../../extension/lib/history.js';
import { defaultSettings, UserError } from '../../extension/lib/storage.js';
import { exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';

const NOW = new Date('2026-09-28T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('alerts', () => {
  test('makeAlert fills defaults and clamps severity', () => {
    const a = makeAlert({ kind: 'reminder', title: 'T', body: 'B', severity: 'apocalyptic' }, NOW);
    assert.equal(a.severity, 'info');
    assert.equal(a.serviceId, null);
    assert.equal(a.read, false);
    assert.equal(a.dismissed, false);
    assert.equal(a.createdAt, NOW.toISOString());
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.equal('optOutId' in a, false);
  });

  test('maxSeverity', () => {
    assert.equal(maxSeverity([]), 'info');
    assert.equal(maxSeverity(['info', 'critical', 'warning']), 'critical');
    assert.equal(maxSeverity(['bogus', 'warning']), 'warning');
  });

  test('mergeAlerts: newest first, capped, active duplicates skipped', () => {
    const svc = makeService();
    const old = flipBackAlert(svc, svc.optOuts[0], 'verify', new Date('2026-09-01T00:00:00Z'));
    const dup = flipBackAlert(svc, svc.optOuts[0], 'passive', NOW);
    const other = makeAlert({ kind: 'reminder', serviceId: 'chatgpt', title: 'T', body: 'B' }, NOW);
    const { alerts, added } = mergeAlerts([old], [dup, other], 10);
    assert.deepEqual(added, [other]);
    assert.deepEqual(
      alerts.map((a) => a.id),
      [other.id, old.id],
    );

    // Once read, the same thing can be alerted again.
    const again = mergeAlerts([{ ...old, read: true }], [dup], 10);
    assert.equal(again.added.length, 1);

    const many = Array.from({ length: 5 }, (_, i) =>
      makeAlert({ kind: 'reminder', serviceId: `s${i}`, title: 'T', body: 'B' }, new Date(NOW.getTime() + i)),
    );
    assert.equal(mergeAlerts([], many, 3).alerts.length, 3);
    assert.equal(mergeAlerts([], many, 3).alerts[0].serviceId, 's4');
  });

  test('policy alerts for the same version are never duplicated, even when read', () => {
    const base = { kind: 'policy_change', serviceId: 'chatgpt', title: 'T', body: 'B', policyVersion: 2 };
    const first = makeAlert(base, NOW);
    const { added } = mergeAlerts([{ ...first, read: true, dismissed: true }], [makeAlert(base, NOW)]);
    assert.deepEqual(added, []);
    const next = mergeAlerts([first], [makeAlert({ ...base, policyVersion: 3 }, NOW)]);
    assert.equal(next.added.length, 1);
  });

  test('markAlert validates the patch and the id', () => {
    const a = makeAlert({ kind: 'reminder', title: 'T', body: 'B' }, NOW);
    assert.equal(markAlert([a], a.id, { read: true })[0].read, true);
    const dismissed = markAlert([a], a.id, { dismissed: true })[0];
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.read, true, 'dismissing implies read');
    assert.throws(() => markAlert([a], 'nope', { read: true }), /Unknown alert/);
    assert.throws(() => markAlert([a], a.id, { title: 'x' }), UserError);
    assert.throws(() => markAlert([a], a.id, { read: 'yes' }), UserError);
    assert.throws(() => markAlert([a], a.id, {}), UserError);
    assert.throws(() => markAlert([a], a.id, null), UserError);
  });

  test('markAllRead and markPolicyAlertsRead', () => {
    const p = makeAlert({ kind: 'policy_change', serviceId: 'chatgpt', title: 'T', body: 'B' });
    const q = makeAlert({ kind: 'policy_change', serviceId: 'example', title: 'T', body: 'B' });
    const f = makeAlert({ kind: 'flip_back', serviceId: 'chatgpt', title: 'T', body: 'B' });
    assert.ok(markAllRead([p, f]).every((a) => a.read));
    const marked = markPolicyAlertsRead([p, q, f], 'chatgpt');
    assert.deepEqual(
      marked.map((a) => a.read),
      [true, false, false],
    );
  });
});

describe('dueReminders', () => {
  const registry = makeRegistry([makeService(), exampleService()]);
  const settings = { ...defaultSettings(), reminderIntervalDays: 30 };
  const state = (rec, tracked = true) => ({
    services: {
      chatgpt: { tracked, source: 'manual', addedAt: daysAgo(100), optOuts: { 'improve-model-toggle': rec } },
    },
  });

  test('one reminder per tracked service with a stale done opt-out', () => {
    const userState = state({ status: 'done', method: 'auto', updatedAt: daysAgo(40), verifiedAt: daysAgo(31) });
    const due = dueReminders({ registry, userState, settings, alerts: [] }, NOW);
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, 'reminder');
    assert.equal(due[0].serviceId, 'chatgpt');
    assert.match(due[0].body, /30 days/);
  });

  test('uses updatedAt when never verified; ignores fresh, not-done and untracked', () => {
    const cases = [
      [state({ status: 'done', method: 'manual', updatedAt: daysAgo(31), verifiedAt: null }), 1],
      [state({ status: 'done', method: 'auto', updatedAt: daysAgo(40), verifiedAt: daysAgo(5) }), 0],
      [state({ status: 'sent', method: 'letter', updatedAt: daysAgo(400), verifiedAt: null }), 0],
      [state({ status: 'done', method: 'auto', updatedAt: daysAgo(40), verifiedAt: null }, false), 0],
    ];
    for (const [userState, n] of cases) {
      assert.equal(dueReminders({ registry, userState, settings, alerts: [] }, NOW).length, n);
    }
  });

  test('deduplicated against recent or still-unread reminders', () => {
    const userState = state({ status: 'done', method: 'auto', updatedAt: daysAgo(40), verifiedAt: null });
    const recent = { kind: 'reminder', serviceId: 'chatgpt', createdAt: daysAgo(3), read: true, dismissed: true };
    assert.equal(dueReminders({ registry, userState, settings, alerts: [recent] }, NOW).length, 0);
    const oldUnread = { ...recent, createdAt: daysAgo(60), read: false, dismissed: false };
    assert.equal(dueReminders({ registry, userState, settings, alerts: [oldUnread] }, NOW).length, 0);
    const oldHandled = { ...recent, createdAt: daysAgo(60) };
    assert.equal(dueReminders({ registry, userState, settings, alerts: [oldHandled] }, NOW).length, 1);
  });
});

describe('history', () => {
  test('entries are newest first and capped', () => {
    let h = [];
    for (let i = 0; i < 5; i += 1) {
      h = appendHistory(h, makeHistoryEntry({ serviceId: 's', optOutId: 'o', action: 'auto', outcome: `o${i}` }), 3);
    }
    assert.deepEqual(
      h.map((e) => e.outcome),
      ['o4', 'o3', 'o2'],
    );
  });

  test('appendHistory with several entries keeps the last one first', () => {
    const a = makeHistoryEntry({ serviceId: 's', optOutId: 'o', action: 'auto', outcome: 'a' });
    const b = makeHistoryEntry({ serviceId: 's', optOutId: 'o', action: 'auto', outcome: 'b' });
    assert.deepEqual(
      appendHistory([], [a, b]).map((e) => e.outcome),
      ['b', 'a'],
    );
  });

  test('detail is trimmed, capped and omitted when empty', () => {
    const e = makeHistoryEntry({ serviceId: 's', optOutId: 'o', action: 'manual', outcome: 'done', detail: `  ${'x'.repeat(400)}` });
    assert.equal(e.detail.length, 300);
    const f = makeHistoryEntry({ serviceId: 's', optOutId: 'o', action: 'manual', outcome: 'done', detail: '   ' });
    assert.equal('detail' in f, false);
  });
});
