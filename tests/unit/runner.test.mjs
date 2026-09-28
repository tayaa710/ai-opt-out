import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock, senders, tick } from './helpers/chrome-mock.mjs';
import {
  TEST_MANIFEST,
  exampleService,
  formOptOut,
  makeRegistry,
  makeService,
  rogueService,
  toggleOptOut,
} from './helpers/fixtures.mjs';
import {
  CONTENT_FILES,
  MAX_RUNS,
  RUN_TTL_MS,
  forgetTab,
  getRun,
  handleGuidedDone,
  handleRunProgress,
  handleRunResult,
  overlayConfig,
  pruneRuns,
  runOptOut,
  startOverlayInPage,
} from '../../extension/lib/runner.js';
import { migrateStorage, readLocal, writeLocal } from '../../extension/lib/storage.js';
import { ensureRegistry } from '../../extension/lib/registry.js';
import { _resetIconCheck } from '../../extension/lib/notify.js';

const noVerify = makeService({
  id: 'noverify',
  name: 'No Verify',
  optOuts: [toggleOptOut({ automation: { ...toggleOptOut().automation, verify: undefined } })],
});
delete noVerify.optOuts[0].automation.verify;
const REGISTRY = makeRegistry([makeService(), exampleService(), rogueService(), noVerify]);
const TOGGLE = 'improve-model-toggle';

/** Makes executeScript behave like a page: runs the injected function with a fake location/overlay. */
function simulatePage(mock, { overlay = true, onStart } = {}) {
  const started = [];
  mock.scripting.executeImpl = async (details, tab) => {
    if (details.files) return [{ frameId: 0, documentId: 'doc-1', result: null }];
    const saved = { location: globalThis.location, overlay: globalThis.NoTrainOverlay };
    globalThis.location = new URL(tab.url);
    globalThis.NoTrainOverlay = overlay ? { start: (cfg) => started.push(cfg) } : undefined;
    try {
      const result = details.func(...details.args);
      if (onStart) await onStart(tab);
      return [{ frameId: 0, documentId: 'doc-1', result }];
    } finally {
      globalThis.location = saved.location;
      globalThis.NoTrainOverlay = saved.overlay;
    }
  };
  return started;
}

let mock;
async function setup(options = {}) {
  _resetIconCheck();
  mock = installChromeMock({ manifest: TEST_MANIFEST, registry: REGISTRY, ...options });
  await migrateStorage();
  await ensureRegistry();
}
afterEach(() => mock?.uninstall());

describe('runOptOut without injection', () => {
  beforeEach(() => setup());

  test('no permission: opens the tab, does not inject, says why', async () => {
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.equal(r.injected, false);
    assert.equal(r.reason, 'no_permission');
    assert.equal(typeof r.runId, 'string');
    assert.deepEqual(mock.tabs.created, [{ id: r.tabId, url: 'https://chatgpt.com/#settings/DataControls' }]);
    assert.equal(mock.scripting.calls.length, 0);
    const run = await getRun(r.runId);
    assert.equal(run.phase, 'not_injected');
  });

  test('guided mode on an opt-out without automation opens the page only', async () => {
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: 'privacy-portal', mode: 'guided' });
    assert.deepEqual([r.injected, r.reason], [false, 'no_automation']);
    assert.equal(mock.tabs.created[0].url, 'https://privacy.openai.com/');
  });

  test('a recipe whose hosts the manifest does not declare is never injected', async () => {
    mock.preGrant({ origins: ['https://evil.test/*'] });
    const r = await runOptOut({ serviceId: 'rogue', optOutId: 'toggle', mode: 'auto' });
    assert.deepEqual([r.injected, r.reason], [false, 'not_allowed']);
    assert.equal(mock.scripting.calls.length, 0);
  });

  test('invalid requests are rejected before any tab opens', async () => {
    await assert.rejects(runOptOut({ serviceId: 'nope', optOutId: TOGGLE, mode: 'auto' }), /Unknown service/);
    await assert.rejects(
      runOptOut({ serviceId: 'chatgpt', optOutId: 'nope', mode: 'auto' }),
      /Unknown opt-out/,
    );
    await assert.rejects(
      runOptOut({ serviceId: 'chatgpt', optOutId: 'privacy-portal', mode: 'auto' }),
      /cannot be automated/,
    );
    await assert.rejects(
      runOptOut({ serviceId: 'noverify', optOutId: TOGGLE, mode: 'verify' }),
      /no verification/,
    );
    await assert.rejects(runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'turbo' }), /mode/);
    assert.equal(mock.tabs.created.length, 0);
  });
});

describe('runOptOut with permission', () => {
  beforeEach(async () => {
    await setup();
    mock.preGrant({ origins: ['https://chatgpt.com/*', 'https://*.example.org/*'] });
  });

  test('injects engine then overlay, then starts the overlay with the run config', async () => {
    const started = simulatePage(mock);
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.equal(r.injected, true);
    assert.equal(r.reason, undefined);
    const [files, start] = mock.scripting.calls;
    assert.deepEqual(files.files, [...CONTENT_FILES]);
    assert.deepEqual(files.target, { tabId: r.tabId, frameIds: [0] });
    assert.equal(start.func, 'startOverlayInPage');
    assert.deepEqual(start.target, { tabId: r.tabId, documentIds: ['doc-1'] }, 'pinned to the same document');
    const { registry } = await readLocal(['registry']);
    const svc = registry.services[0];
    assert.deepEqual(started, [overlayConfig(r.runId, 'auto', svc, svc.optOuts[0])]);
    assert.deepEqual(Object.keys(started[0]).sort(), ['mode', 'optOut', 'runId', 'service']);
    assert.equal((await getRun(r.runId)).phase, 'running');
  });

  test('wildcard manifest patterns cover specific recipe hosts', async () => {
    simulatePage(mock);
    const r = await runOptOut({ serviceId: 'example', optOutId: 'ai-toggle', mode: 'verify' });
    assert.equal(r.injected, true);
  });

  test('redirected to another host (e.g. a login page) → navigated_away, nothing injected', async () => {
    mock.uninstall();
    await setup({ autoCompleteTabs: false });
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    const p = runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    await tick(5);
    mock.completeTab(mock.tabs.created[0].id, 'https://auth.openai.com/log-in');
    const r = await p;
    assert.deepEqual([r.injected, r.reason], [false, 'navigated_away']);
    assert.equal(mock.scripting.calls.length, 0);
  });

  test('tab closed while loading → tab_closed', async () => {
    mock.uninstall();
    await setup({ autoCompleteTabs: false });
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    const p = runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    await tick(5);
    mock.closeTab(mock.tabs.created[0].id);
    const r = await p;
    assert.deepEqual([r.injected, r.reason], [false, 'tab_closed']);
  });

  test('a page that never finishes loading is injected after the load timeout', async () => {
    mock.uninstall();
    await setup({ autoCompleteTabs: false });
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    simulatePage(mock);
    const p = runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' }, { loadTimeoutMs: 20 });
    await tick(5);
    mock.navigateTab(mock.tabs.created[0].id, 'https://chatgpt.com/');
    const r = await p;
    assert.equal(r.injected, true);
  });

  test('injection errors → injection_failed (or tab_closed if the tab is gone)', async () => {
    mock.scripting.executeImpl = async () => {
      throw new Error('Cannot access contents of the page');
    };
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.deepEqual([r.injected, r.reason], [false, 'injection_failed']);
    mock.scripting.executeImpl = async (details) => {
      mock.closeTab(details.target.tabId);
      throw new Error('No tab with id');
    };
    const r2 = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.deepEqual([r2.injected, r2.reason], [false, 'tab_closed']);
  });

  test('overlay missing in the page → injection_failed', async () => {
    simulatePage(mock, { overlay: false });
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.deepEqual([r.injected, r.reason], [false, 'injection_failed']);
  });

  test('Firefox (no documentId): the start call targets the top frame', async () => {
    mock.scripting.executeImpl = async (details) => [
      { frameId: 0, result: details.files ? null : { started: true } },
    ];
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.equal(r.injected, true);
    assert.deepEqual(mock.scripting.calls[1].target, { tabId: r.tabId, frameIds: [0] });
  });

  test('a result reported before runOptOut returns is not overwritten', async () => {
    let runId;
    simulatePage(mock, {
      onStart: async (tab) => {
        const runs = mock.storage.session.dump().runs;
        runId = Object.keys(runs)[0];
        await handleRunResult(
          {
            type: 'runResult',
            runId,
            serviceId: 'chatgpt',
            optOutId: TOGGLE,
            mode: 'auto',
            outcome: 'already',
          },
          senders.content(tab.id, tab.url),
        );
      },
    });
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    assert.equal(r.runId, runId);
    const run = await getRun(runId);
    assert.equal(run.phase, 'finished');
    assert.equal(run.outcome, 'already');
  });
});

describe('content-script reports', () => {
  let run;
  let sender;
  beforeEach(async () => {
    await setup();
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    simulatePage(mock);
    run = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    sender = senders.content(run.tabId, 'https://chatgpt.com/#settings/DataControls');
  });

  test('runProgress is stored on the run', async () => {
    const r = await handleRunProgress(
      { runId: run.runId, stepIndex: 1, total: 3, description: 'x'.repeat(300) },
      sender,
    );
    assert.deepEqual(r, { recorded: true });
    const stored = await getRun(run.runId);
    assert.equal(stored.progress.stepIndex, 1);
    assert.equal(stored.progress.description.length, 200);
    await assert.rejects(
      handleRunProgress({ runId: run.runId, stepIndex: -1, total: 3 }, sender),
      /stepIndex/,
    );
    await assert.rejects(handleRunProgress({ runId: run.runId, stepIndex: 0, total: 'x' }, sender), /total/);
  });

  test('reports from another tab, frame or site, or for unknown runs, are rejected', async () => {
    const msg = {
      runId: run.runId,
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      mode: 'auto',
      outcome: 'success',
    };
    await assert.rejects(handleRunResult(msg, senders.content(999, 'https://chatgpt.com/')), /another tab/);
    await assert.rejects(
      handleRunResult(msg, senders.content(run.tabId, 'https://chatgpt.com/', 3)),
      /another tab/,
    );
    await assert.rejects(
      handleRunResult(msg, senders.content(run.tabId, 'https://evil.test/')),
      /another site/,
    );
    await assert.rejects(handleRunResult({ ...msg, runId: 'nope' }, sender), /Unknown run/);
    await assert.rejects(handleRunResult({ ...msg, runId: 42 }, sender), /Unknown run/);
    await assert.rejects(handleRunResult({ ...msg, serviceId: 'example' }, sender), /mismatch/);
    await assert.rejects(handleRunResult({ ...msg, mode: 'verify' }, sender), /mismatch/);
    await assert.rejects(handleRunResult({ ...msg, outcome: 'victory' }, sender), /outcome/);
    const { userState } = await readLocal(['userState']);
    assert.deepEqual(userState.services, {});
  });

  test('reports for a run that was never injected are rejected', async () => {
    mock.permissions.contains = async () => false;
    const r = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    await assert.rejects(
      handleRunResult(
        { runId: r.runId, outcome: 'success' },
        senders.content(r.tabId, 'https://chatgpt.com/'),
      ),
      /Unknown run/,
    );
  });

  test('success → done (auto, verified), history entry, run finished', async () => {
    await handleRunResult(
      {
        runId: run.runId,
        serviceId: 'chatgpt',
        optOutId: TOGGLE,
        mode: 'auto',
        outcome: 'success',
        message: 'Turned off',
      },
      sender,
    );
    const { userState, history, alerts } = await readLocal(['userState', 'history', 'alerts']);
    const rec = userState.services.chatgpt.optOuts[TOGGLE];
    assert.equal(rec.status, 'done');
    assert.equal(rec.method, 'auto');
    assert.ok(rec.verifiedAt);
    assert.equal(userState.services.chatgpt.tracked, true);
    assert.equal(history[0].action, 'auto');
    assert.equal(history[0].outcome, 'success');
    assert.equal(history[0].detail, 'Turned off');
    assert.deepEqual(alerts, []);
    assert.equal((await getRun(run.runId)).phase, 'finished');
  });

  test('needs_login keeps the status and records the outcome', async () => {
    await handleRunResult({ runId: run.runId, outcome: 'needs_login' }, sender);
    const { userState, history } = await readLocal(['userState', 'history']);
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].status, 'not_started');
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].lastOutcome, 'needs_login');
    assert.equal(history[0].outcome, 'needs_login');
  });

  test('guidedDone → done via guided, allowed after a failed automated attempt', async () => {
    await handleRunResult({ runId: run.runId, outcome: 'not_found' }, sender);
    await handleGuidedDone({ runId: run.runId, serviceId: 'chatgpt', optOutId: TOGGLE }, sender);
    const { userState, history } = await readLocal(['userState', 'history']);
    const rec = userState.services.chatgpt.optOuts[TOGGLE];
    assert.equal(rec.status, 'done');
    assert.equal(rec.method, 'guided');
    assert.equal(rec.verifiedAt, null);
    assert.deepEqual(
      history.map((h) => `${h.action}:${h.outcome}`),
      ['guided:success', 'auto:not_found'],
    );
    await assert.rejects(handleGuidedDone({ runId: run.runId, serviceId: 'example' }, sender), /mismatch/);
  });

  test('forgetTab drops the tab’s runs', async () => {
    await forgetTab(run.tabId);
    assert.equal(await getRun(run.runId), null);
    await forgetTab(12345); // unknown tab: no-op
  });
});

describe('verify mismatch (flip-back)', () => {
  let sender;
  let run;
  beforeEach(async () => {
    await setup();
    mock.preGrant({ origins: ['https://chatgpt.com/*'] });
    simulatePage(mock);
    await writeLocal({
      userState: {
        services: {
          chatgpt: {
            tracked: true,
            source: 'manual',
            addedAt: '2026-09-01T00:00:00.000Z',
            knownPolicyVersion: 1,
            optOuts: {
              [TOGGLE]: {
                status: 'done',
                method: 'auto',
                updatedAt: '2026-09-01T00:00:00.000Z',
                verifiedAt: null,
              },
            },
          },
        },
      },
    });
    run = await runOptOut({ serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'verify' });
    sender = senders.content(run.tabId, 'https://chatgpt.com/');
  });

  test('mismatch → needs_attention + flip_back alert + notification', async () => {
    await handleRunResult({ runId: run.runId, outcome: 'mismatch' }, sender);
    const { userState, alerts, history } = await readLocal(['userState', 'alerts', 'history']);
    assert.equal(userState.services.chatgpt.optOuts[TOGGLE].status, 'needs_attention');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'flip_back');
    assert.equal(alerts[0].optOutId, TOGGLE);
    assert.equal(history[0].action, 'verify');
    assert.equal(mock.notifications.shown.size, 1);
    const [id] = mock.notifications.shown.keys();
    assert.match(id, /^notrain:flip_back:chatgpt:/);
  });

  test('no notification when flip-back notifications are off', async () => {
    const { settings } = await readLocal(['settings']);
    await writeLocal({
      settings: { ...settings, notifications: { ...settings.notifications, flipBacks: false } },
    });
    await handleRunResult({ runId: run.runId, outcome: 'mismatch' }, sender);
    assert.equal(mock.notifications.shown.size, 0);
    assert.equal((await readLocal(['alerts'])).alerts.length, 1);
  });

  test('verify success keeps the method and refreshes verifiedAt', async () => {
    await handleRunResult({ runId: run.runId, outcome: 'success' }, sender);
    const rec = (await readLocal(['userState'])).userState.services.chatgpt.optOuts[TOGGLE];
    assert.equal(rec.status, 'done');
    assert.equal(rec.method, 'auto');
    assert.ok(rec.verifiedAt);
  });
});

describe('helpers', () => {
  test('pruneRuns drops expired runs and keeps the newest MAX_RUNS', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const runs = {};
    for (let i = 0; i < MAX_RUNS + 5; i += 1) {
      runs[`r${i}`] = { runId: `r${i}`, startedAt: new Date(now - i * 1000).toISOString() };
    }
    runs.old = { runId: 'old', startedAt: new Date(now - RUN_TTL_MS - 1).toISOString() };
    const kept = pruneRuns(runs, now);
    assert.equal(Object.keys(kept).length, MAX_RUNS);
    assert.ok(kept.r0);
    assert.equal(kept.old, undefined);
  });

  test('startOverlayInPage re-checks the host and never waits for the run', () => {
    const saved = { location: globalThis.location, overlay: globalThis.NoTrainOverlay };
    try {
      const calls = [];
      globalThis.NoTrainOverlay = {
        start: (cfg) => {
          calls.push(cfg);
          return Promise.reject(new Error('run failed later'));
        },
      };
      globalThis.location = new URL('https://www.example.org/x');
      assert.deepEqual(startOverlayInPage({ a: 1 }, ['https://*.example.org/*']), { started: true });
      globalThis.location = new URL('https://example.org/x');
      assert.deepEqual(startOverlayInPage({ a: 1 }, ['https://*.example.org/*']), { started: true });
      globalThis.location = new URL('https://evil.test/');
      assert.deepEqual(startOverlayInPage({}, ['https://chatgpt.com/*']), {
        started: false,
        reason: 'navigated_away',
      });
      globalThis.location = new URL('http://chatgpt.com/');
      assert.deepEqual(startOverlayInPage({}, ['https://chatgpt.com/*']), {
        started: false,
        reason: 'navigated_away',
      });
      globalThis.location = new URL('https://chatgpt.com/');
      globalThis.NoTrainOverlay = {
        start: () => {
          throw new Error('boom');
        },
      };
      assert.deepEqual(startOverlayInPage({}, ['https://chatgpt.com/*']), {
        started: false,
        reason: 'injection_failed',
        detail: 'boom',
      });
      assert.equal(calls.length, 2);
    } finally {
      globalThis.location = saved.location;
      globalThis.NoTrainOverlay = saved.overlay;
    }
  });

  test('overlayConfig exposes only what the overlay needs', () => {
    const svc = makeService();
    const cfg = overlayConfig('run-1', 'guided', svc, formOptOut());
    assert.deepEqual(cfg.service, { id: 'chatgpt', name: 'ChatGPT', company: 'OpenAI' });
    assert.equal(cfg.optOut.automation, null);
  });
});
