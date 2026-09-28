import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_META,
  applicableOptOuts,
  compareByUrgency,
  hasPendingPolicyChange,
  optOutStatus,
  serviceForUrl,
  serviceStatus,
  summarize,
} from '../../extension/lib/status.js';
import { bumpPolicy, formOptOut, makeService, toggleOptOut } from './helpers/fixtures.mjs';

const TOGGLE = 'improve-model-toggle';
const tracked = (optOuts = {}, extra = {}) => ({
  services: {
    chatgpt: {
      tracked: true,
      source: 'manual',
      addedAt: '2026-09-01T00:00:00Z',
      knownPolicyVersion: 1,
      optOuts,
      ...extra,
    },
  },
});
const rec = (status) => ({ status, method: 'manual', updatedAt: '2026-09-01T00:00:00Z', verifiedAt: null });

describe('applicableOptOuts', () => {
  test('keeps actionable types that apply to the region', () => {
    const svc = makeService({
      optOuts: [
        toggleOptOut(),
        formOptOut({ id: 'eu-form', regions: ['EU'] }),
        formOptOut({ id: 'delete', type: 'account-deletion' }),
        formOptOut({ id: 'none', type: 'none' }),
        formOptOut({ id: 'mail', type: 'email', regions: ['US'] }),
      ],
    });
    assert.deepEqual(
      applicableOptOuts(svc, 'EU').map((o) => o.id),
      [TOGGLE, 'eu-form'],
    );
    assert.deepEqual(
      applicableOptOuts(svc, 'US-CA').map((o) => o.id),
      [TOGGLE, 'mail'],
    );
    assert.deepEqual(
      applicableOptOuts(svc, 'JP').map((o) => o.id),
      [TOGGLE],
    );
    assert.deepEqual(applicableOptOuts({ id: 'x' }, 'EU'), []);
  });
});

describe('optOutStatus / hasPendingPolicyChange', () => {
  test('absent means not_started', () => {
    assert.equal(optOutStatus({ services: {} }, 'chatgpt', TOGGLE), 'not_started');
    assert.equal(optOutStatus(undefined, 'chatgpt', TOGGLE), 'not_started');
    assert.equal(optOutStatus(tracked({ [TOGGLE]: rec('done') }), 'chatgpt', TOGGLE), 'done');
  });

  test('only warning/critical changes the user has not acknowledged, on tracked services', () => {
    const svc = bumpPolicy(makeService(), 'warning');
    assert.equal(hasPendingPolicyChange(svc, tracked().services.chatgpt), true);
    assert.equal(
      hasPendingPolicyChange(svc, { ...tracked().services.chatgpt, knownPolicyVersion: 2 }),
      false,
    );
    assert.equal(hasPendingPolicyChange(svc, { ...tracked().services.chatgpt, tracked: false }), false);
    assert.equal(hasPendingPolicyChange(svc, undefined), false);
    assert.equal(
      hasPendingPolicyChange(bumpPolicy(makeService(), 'info'), tracked().services.chatgpt),
      false,
    );
    const noKnown = { ...tracked().services.chatgpt };
    delete noKnown.knownPolicyVersion;
    assert.equal(hasPendingPolicyChange(svc, noKnown), false, 'missing knownPolicyVersion means current');
  });
});

describe('serviceStatus', () => {
  const svc = makeService();

  test('not tracked', () => {
    const s = serviceStatus(svc, { services: {} }, 'EU');
    assert.equal(s.code, 'not_tracked');
    assert.equal(s.label, STATUS_META.not_tracked.label);
    assert.equal(s.tone, 'neutral');
  });

  test('action needed → protected once done or sent', () => {
    assert.equal(serviceStatus(svc, tracked(), 'EU').code, 'action_needed');
    assert.equal(serviceStatus(svc, tracked({ [TOGGLE]: rec('done') }), 'EU').code, 'protected');
    const sent = serviceStatus(svc, tracked({ 'privacy-portal': rec('sent') }), 'EU');
    assert.equal(sent.code, 'protected');
    assert.equal(sent.done, 1);
    assert.equal(sent.tone, 'good');
    assert.equal(serviceStatus(svc, tracked({ [TOGGLE]: rec('skipped') }), 'EU').code, 'action_needed');
  });

  test('needs attention wins over protected (flip-back or pending policy change)', () => {
    assert.equal(
      serviceStatus(svc, tracked({ [TOGGLE]: rec('needs_attention'), 'privacy-portal': rec('sent') }), 'EU')
        .code,
      'needs_attention',
    );
    const changed = serviceStatus(bumpPolicy(svc, 'critical'), tracked({ [TOGGLE]: rec('done') }), 'EU');
    assert.equal(changed.code, 'needs_attention');
    assert.equal(changed.pendingPolicyChange, true);
    assert.equal(changed.tone, 'bad');
  });

  test('safe by default, no opt-out, not in region', () => {
    const safe = makeService({ training: { ...svc.training, trainsOnUserData: 'no' } });
    assert.equal(serviceStatus(safe, tracked(), 'EU').code, 'safe_by_default');
    const optedOut = makeService({ training: { ...svc.training, defaultState: 'opted_out' } });
    assert.equal(serviceStatus(optedOut, tracked(), 'EU').code, 'safe_by_default');
    const none = makeService({ optOuts: [formOptOut({ type: 'none' })] });
    assert.equal(serviceStatus(none, tracked(), 'EU').code, 'no_opt_out');
    const euOnly = makeService({ optOuts: [formOptOut({ regions: ['EU'] })] });
    assert.equal(serviceStatus(euOnly, tracked(), 'US').code, 'not_in_region');
  });
});

describe('summarize / compareByUrgency', () => {
  test('summary counts', () => {
    const a = makeService();
    const b = makeService({ id: 'b', name: 'B' });
    const c = makeService({ id: 'c', name: 'C', optOuts: [formOptOut({ type: 'none' })] });
    const d = makeService({ id: 'd', name: 'D' });
    const e = makeService({ id: 'e', name: 'E' });
    const base = { tracked: true, source: 'manual', addedAt: '2026-01-01T00:00:00Z', knownPolicyVersion: 1 };
    const userState = {
      services: {
        chatgpt: { ...base, optOuts: { [TOGGLE]: rec('done') } },
        b: { ...base, optOuts: {} },
        c: { ...base, optOuts: {} },
        d: { ...base, optOuts: { [TOGGLE]: rec('needs_attention') } },
      },
    };
    assert.deepEqual(summarize([a, b, c, d, e], userState, 'EU'), {
      tracked: 4,
      protected: 1,
      actionNeeded: 1,
      attention: 1,
      informational: 1,
    });
  });

  test('most urgent first, then by name', () => {
    const base = { tracked: true, source: 'manual', addedAt: '2026-01-01T00:00:00Z', knownPolicyVersion: 1 };
    const svcs = ['Zeta', 'Alpha', 'Mid', 'Bravo'].map((name) =>
      makeService({ id: name.toLowerCase(), name }),
    );
    const userState = {
      services: {
        zeta: { ...base, optOuts: { [TOGGLE]: rec('needs_attention') } },
        alpha: { ...base, optOuts: { [TOGGLE]: rec('done') } },
        mid: { ...base, optOuts: {} },
      },
    };
    const sorted = [...svcs].sort((x, y) => compareByUrgency(x, y, userState, 'EU'));
    assert.deepEqual(
      sorted.map((s) => s.name),
      ['Zeta', 'Mid', 'Alpha', 'Bravo'],
    );
  });
});

describe('serviceForUrl', () => {
  const svcs = [
    makeService({ id: 'openai', name: 'OpenAI', domains: ['openai.com'] }),
    makeService({ id: 'chatgpt', domains: ['chatgpt.com', 'chat.openai.com'] }),
  ];

  test('exact host, subdomain and longest-domain match', () => {
    assert.equal(serviceForUrl(svcs, 'https://chatgpt.com/c/1').id, 'chatgpt');
    assert.equal(serviceForUrl(svcs, 'https://www.chatgpt.com/').id, 'chatgpt');
    assert.equal(serviceForUrl(svcs, 'https://chat.openai.com/').id, 'chatgpt');
    assert.equal(serviceForUrl(svcs, 'https://platform.openai.com/').id, 'openai');
    assert.equal(serviceForUrl(svcs, 'https://CHATGPT.COM/').id, 'chatgpt');
  });

  test('no false positives', () => {
    assert.equal(serviceForUrl(svcs, 'https://notchatgpt.com/'), null);
    assert.equal(serviceForUrl(svcs, 'https://chatgpt.com.evil.test/'), null);
    assert.equal(serviceForUrl(svcs, 'chrome://extensions'), null);
    assert.equal(serviceForUrl(svcs, 'not a url'), null);
    assert.equal(serviceForUrl([], 'https://chatgpt.com/'), null);
  });
});
