import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertsForDiff,
  diffRegistries,
  newServicesAlert,
  policyChange,
  policyChangeAlert,
} from '../../extension/lib/registry-diff.js';
import { bumpPolicy, exampleService, makeRegistry, makeService } from './helpers/fixtures.mjs';

const tracked = (ids, known = {}) => ({
  services: Object.fromEntries(
    ids.map((id) => [
      id,
      {
        tracked: true,
        source: 'manual',
        addedAt: '2026-01-01T00:00:00Z',
        knownPolicyVersion: known[id] ?? 1,
        optOuts: {},
      },
    ]),
  ),
});

describe('diffRegistries', () => {
  test('finds added, removed and policy-changed services', () => {
    const a = makeService();
    const b = exampleService();
    const prev = makeRegistry([a, b]);
    const c = makeService({ id: 'newcomer', name: 'Newcomer' });
    const next = makeRegistry([bumpPolicy(a, 'critical'), c]);
    const d = diffRegistries(prev, next);
    assert.deepEqual(
      d.added.map((s) => s.id),
      ['newcomer'],
    );
    assert.deepEqual(d.removed, ['example']);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].fromVersion, 1);
    assert.equal(d.changed[0].toVersion, 2);
    assert.equal(d.changed[0].severity, 'critical');
  });

  test('no previous registry: everything is added', () => {
    const d = diffRegistries(null, makeRegistry());
    assert.equal(d.added.length, 2);
    assert.deepEqual(d.changed, []);
  });

  test('a lower or equal policyVersion is not a change', () => {
    const a = bumpPolicy(makeService());
    const d = diffRegistries(makeRegistry([a]), makeRegistry([makeService()]));
    assert.deepEqual(d.changed, []);
  });
});

describe('policyChange', () => {
  test('includes only entries after fromVersion up to policyVersion, newest first, max severity', () => {
    let s = makeService();
    s = bumpPolicy(s, 'info', 'Minor wording change in help docs.');
    s = bumpPolicy(s, 'warning', 'New opt-out form available.');
    s.changelog.push({
      version: 9,
      date: '2026-09-21',
      summary: 'Future entry not yet live.',
      severity: 'critical',
    });
    const c = policyChange(s, 1);
    assert.deepEqual(
      c.entries.map((e) => e.version),
      [3, 2],
    );
    assert.equal(c.severity, 'warning');
  });
});

describe('alertsForDiff', () => {
  test('creates policy alerts only for tracked services', () => {
    const a = makeService();
    const b = exampleService();
    const d = diffRegistries(makeRegistry([a, b]), makeRegistry([bumpPolicy(a), bumpPolicy(b)]));
    const alerts = alertsForDiff(d, tracked(['chatgpt']));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'policy_change');
    assert.equal(alerts[0].serviceId, 'chatgpt');
    assert.equal(alerts[0].severity, 'warning');
    assert.equal(alerts[0].policyVersion, 2);
    assert.match(alerts[0].body, /voice recordings/);
    assert.equal(alerts[0].read, false);
  });

  test('skips changes the user already knows about and trims to unseen entries', () => {
    let s = makeService();
    const v1 = s;
    s = bumpPolicy(s, 'critical', 'Training turned on by default for everyone.');
    s = bumpPolicy(s, 'info', 'Clarified the help article wording.');
    const d = diffRegistries(makeRegistry([v1]), makeRegistry([s]));
    // User already acknowledged version 2 (e.g. from a bundled update).
    const alerts = alertsForDiff(d, tracked(['chatgpt'], { chatgpt: 2 }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'info');
    assert.doesNotMatch(alerts[0].body, /Training turned on/);
    assert.deepEqual(alertsForDiff(d, tracked(['chatgpt'], { chatgpt: 3 })), []);
  });

  test('one grouped new_service alert, optional', () => {
    const d = diffRegistries(makeRegistry([makeService()]), makeRegistry([makeService(), exampleService()]));
    const [alert] = alertsForDiff(d, tracked([]));
    assert.equal(alert.kind, 'new_service');
    assert.equal(alert.serviceId, 'example');
    assert.deepEqual(alert.serviceIds, ['example']);
    assert.deepEqual(alertsForDiff(d, tracked([]), { newServices: false }), []);
  });

  test('grouped alert lists up to five names', () => {
    const many = Array.from({ length: 7 }, (_, i) => makeService({ id: `svc-${i}`, name: `Service ${i}` }));
    const a = newServicesAlert(many);
    assert.equal(a.serviceId, null);
    assert.equal(a.serviceIds.length, 7);
    assert.match(a.title, /7 new services/);
    assert.match(a.body, /and 2 more/);
  });

  test('policy alert without changelog entries still explains itself', () => {
    const s = makeService({ policyVersion: 2 });
    const a = policyChangeAlert(policyChange(s, 1));
    assert.equal(a.severity, 'info');
    assert.match(a.body, /updated/);
  });
});
