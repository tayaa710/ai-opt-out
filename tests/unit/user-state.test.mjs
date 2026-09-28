import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgePolicy,
  applyRunOutcome,
  requireServiceOptOut,
  setOptOutStatus,
  touchVerified,
  trackServices,
} from '../../extension/lib/user-state.js';
import { UserError } from '../../extension/lib/storage.js';
import { bumpPolicy, makeRegistry, makeService } from './helpers/fixtures.mjs';

const NOW = new Date('2026-09-28T12:00:00Z');
const LATER = new Date('2026-09-29T12:00:00Z');
const registry = makeRegistry();
const svc = registry.services[0];
const toggle = svc.optOuts[0];
const empty = () => ({ services: {} });

describe('trackServices', () => {
  test('tracking sets knownPolicyVersion to the current version', () => {
    const reg = makeRegistry([bumpPolicy(makeService())]);
    const u = trackServices(
      empty(),
      reg,
      { serviceIds: ['chatgpt'], tracked: true, source: 'detected' },
      NOW,
    );
    assert.deepEqual(u.services.chatgpt, {
      tracked: true,
      source: 'detected',
      addedAt: NOW.toISOString(),
      knownPolicyVersion: 2,
      optOuts: {},
    });
  });

  test('re-tracking an already tracked service changes nothing', () => {
    const u1 = trackServices(empty(), registry, { serviceIds: ['chatgpt'], tracked: true }, NOW);
    const u2 = trackServices(
      u1,
      registry,
      { serviceIds: ['chatgpt'], tracked: true, source: 'detected' },
      LATER,
    );
    assert.deepEqual(u2, u1);
  });

  test('untracking keeps progress; re-tracking restores it', () => {
    let u = trackServices(empty(), registry, { serviceIds: ['chatgpt'], tracked: true }, NOW);
    u = setOptOutStatus(u, svc, toggle, { status: 'done', method: 'manual' }, NOW);
    u = trackServices(u, registry, { serviceIds: ['chatgpt'], tracked: false });
    assert.equal(u.services.chatgpt.tracked, false);
    assert.equal(u.services.chatgpt.optOuts[toggle.id].status, 'done');
    u = trackServices(u, registry, { serviceIds: ['chatgpt'], tracked: true }, LATER);
    assert.equal(u.services.chatgpt.tracked, true);
    assert.equal(u.services.chatgpt.optOuts[toggle.id].status, 'done');
  });

  test('unknown ids and sources are rejected, input is not mutated', () => {
    const before = empty();
    assert.throws(
      () => trackServices(before, registry, { serviceIds: ['nope'], tracked: true }),
      /Unknown service/,
    );
    assert.throws(
      () => trackServices(before, registry, { serviceIds: ['chatgpt'], tracked: true, source: 'x' }),
      UserError,
    );
    assert.deepEqual(before, empty());
  });
});

describe('setOptOutStatus', () => {
  test('marking done on an untracked service starts tracking it', () => {
    const u = setOptOutStatus(
      empty(),
      svc,
      toggle,
      { status: 'done', method: 'manual', note: ' did it ' },
      NOW,
    );
    assert.equal(u.services.chatgpt.tracked, true);
    assert.equal(u.services.chatgpt.knownPolicyVersion, 1);
    assert.deepEqual(u.services.chatgpt.optOuts[toggle.id], {
      status: 'done',
      method: 'manual',
      updatedAt: NOW.toISOString(),
      verifiedAt: null,
      note: 'did it',
    });
  });

  test('skipping does not start tracking', () => {
    const u = setOptOutStatus(empty(), svc, toggle, { status: 'skipped', method: 'manual' }, NOW);
    assert.equal(u.services.chatgpt.tracked, false);
    assert.equal(u.services.chatgpt.optOuts[toggle.id].status, 'skipped');
  });

  test('keeps the previous note unless a new one is given', () => {
    let u = setOptOutStatus(empty(), svc, toggle, { status: 'done', method: 'manual', note: 'first' }, NOW);
    u = setOptOutStatus(u, svc, toggle, { status: 'skipped', method: 'manual' }, NOW);
    assert.equal(u.services.chatgpt.optOuts[toggle.id].note, 'first');
    u = setOptOutStatus(u, svc, toggle, { status: 'skipped', method: 'manual', note: '' }, NOW);
    assert.equal(u.services.chatgpt.optOuts[toggle.id].note, undefined);
  });

  test('rejects unknown statuses and methods', () => {
    assert.throws(
      () => setOptOutStatus(empty(), svc, toggle, { status: 'finished', method: 'manual' }),
      UserError,
    );
    assert.throws(
      () => setOptOutStatus(empty(), svc, toggle, { status: 'done', method: 'magic' }),
      UserError,
    );
  });
});

describe('applyRunOutcome', () => {
  const done = (method = 'guided') => setOptOutStatus(empty(), svc, toggle, { status: 'done', method }, NOW);

  for (const outcome of ['success', 'already']) {
    test(`${outcome} in auto mode → done, method auto, verified now`, () => {
      const r = applyRunOutcome(empty(), svc, toggle, { mode: 'auto', outcome }, LATER);
      const rec = r.userState.services.chatgpt.optOuts[toggle.id];
      assert.equal(rec.status, 'done');
      assert.equal(rec.method, 'auto');
      assert.equal(rec.verifiedAt, LATER.toISOString());
      assert.equal(rec.lastOutcome, outcome);
      assert.equal(r.userState.services.chatgpt.tracked, true);
      assert.equal(r.statusChanged, true);
      assert.equal(r.flipBack, false);
    });
  }

  test('verify success keeps the original method and refreshes verifiedAt', () => {
    const r = applyRunOutcome(done('guided'), svc, toggle, { mode: 'verify', outcome: 'success' }, LATER);
    const rec = r.userState.services.chatgpt.optOuts[toggle.id];
    assert.equal(rec.method, 'guided');
    assert.equal(rec.verifiedAt, LATER.toISOString());
    assert.equal(r.statusChanged, false);
  });

  test('guided-mode success is recorded as guided', () => {
    const r = applyRunOutcome(empty(), svc, toggle, { mode: 'guided', outcome: 'success' }, LATER);
    assert.equal(r.userState.services.chatgpt.optOuts[toggle.id].method, 'guided');
  });

  test('mismatch → needs_attention and a flip-back (only the first time)', () => {
    const r = applyRunOutcome(done(), svc, toggle, { mode: 'verify', outcome: 'mismatch' }, LATER);
    const rec = r.userState.services.chatgpt.optOuts[toggle.id];
    assert.equal(rec.status, 'needs_attention');
    assert.equal(rec.lastOutcome, 'mismatch');
    assert.equal(r.flipBack, true);
    const again = applyRunOutcome(r.userState, svc, toggle, { mode: 'verify', outcome: 'mismatch' }, LATER);
    assert.equal(again.flipBack, false);
  });

  for (const outcome of ['needs_login', 'not_found', 'failed', 'cancelled']) {
    test(`${outcome} keeps the status and stores lastOutcome`, () => {
      const r = applyRunOutcome(done(), svc, toggle, { mode: 'auto', outcome }, LATER);
      const rec = r.userState.services.chatgpt.optOuts[toggle.id];
      assert.equal(rec.status, 'done');
      assert.equal(rec.lastOutcome, outcome);
      assert.equal(rec.updatedAt, NOW.toISOString());
      const fresh = applyRunOutcome(empty(), svc, toggle, { mode: 'auto', outcome }, LATER);
      assert.equal(fresh.userState.services.chatgpt.optOuts[toggle.id].status, 'not_started');
      assert.equal(fresh.userState.services.chatgpt.tracked, false);
    });
  }
});

describe('acknowledgePolicy / touchVerified / lookups', () => {
  test('acknowledgePolicy sets knownPolicyVersion; untracked services are rejected', () => {
    const reg = makeRegistry([bumpPolicy(makeService())]);
    const u = trackServices(empty(), registry, { serviceIds: ['chatgpt'], tracked: true }, NOW);
    assert.equal(u.services.chatgpt.knownPolicyVersion, 1);
    const acked = acknowledgePolicy(u, reg.services[0]);
    assert.equal(acked.services.chatgpt.knownPolicyVersion, 2);
    assert.throws(() => acknowledgePolicy(empty(), reg.services[0]), UserError);
  });

  test('touchVerified only touches done opt-outs', () => {
    const u = setOptOutStatus(empty(), svc, toggle, { status: 'done', method: 'auto' }, NOW);
    assert.equal(
      touchVerified(u, 'chatgpt', toggle.id, LATER).services.chatgpt.optOuts[toggle.id].verifiedAt,
      LATER.toISOString(),
    );
    const s = setOptOutStatus(empty(), svc, toggle, { status: 'skipped', method: 'manual' }, NOW);
    assert.equal(touchVerified(s, 'chatgpt', toggle.id, LATER), s);
  });

  test('requireServiceOptOut', () => {
    assert.equal(requireServiceOptOut(registry, 'chatgpt', toggle.id).optOut, toggle);
    assert.throws(() => requireServiceOptOut(registry, 'chatgpt', 'nope'), /Unknown opt-out/);
    assert.throws(() => requireServiceOptOut(null, 'chatgpt'), /Unknown service/);
  });
});
