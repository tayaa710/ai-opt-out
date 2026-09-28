// End-to-end tests for the background service worker, driven through
// chrome.runtime.sendMessage from an extension page (as the UI does).
//
// Two browser set-ups:
// - `test`: the extension exactly as shipped (zero host permissions);
// - `grantedTest`: a temporary copy whose manifest grants https://chatgpt.com/*
//   up front, standing in for the user accepting the optional permission.
// Network: chatgpt.com is served from an inline mock of its Data controls UI,
// and the remote registry is served by the test (service-worker requests are
// routable thanks to the flag below, which must be set before the browser starts).

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_DIR, expect, test } from './helpers/extension.mjs';
import { waitForPageUrl } from './helpers/fake-sites.mjs';

const REMOTE_REGISTRY = 'https://raw.githubusercontent.com/**';
const BUNDLED = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'data/registry.json'), 'utf8'));
const CHATGPT = BUNDLED.services.find((s) => s.id === 'chatgpt');
const TOGGLE = 'improve-model-toggle';
const HAS_CONTENT_SCRIPTS = ['engine.js', 'overlay.js'].every((f) =>
  fs.existsSync(path.join(EXTENSION_DIR, 'content', f)),
);

/** A small stand-in for ChatGPT's Settings → Data controls → "Improve the model for everyone". */
function chatgptPage({ on = true } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title></head>
<body>
  <main>
    <h1>Settings</h1>
    <section aria-label="Data controls">
      <div class="row"><span>Improve the model for everyone</span>
        <button id="open" type="button">${on ? 'On' : 'Off'}</button></div>
      <div class="row"><span>Shared links</span><button type="button">Manage</button></div>
    </section>
  </main>
  <script>
    let on = ${on};
    document.getElementById('open').addEventListener('click', () => {
      if (document.getElementById('modal')) return;
      const d = document.createElement('div');
      d.id = 'modal';
      d.setAttribute('role', 'dialog');
      d.setAttribute('aria-label', 'Model improvement');
      d.innerHTML = '<h2>Model improvement</h2><div><span id="lbl">Improve the model for everyone</span>' +
        '<button id="sw" type="button" role="switch" aria-labelledby="lbl"></button></div>' +
        '<button id="done" type="button">Done</button>';
      document.body.appendChild(d);
      const sw = document.getElementById('sw');
      sw.setAttribute('aria-checked', String(on));
      sw.addEventListener('click', () => setTimeout(() => {
        on = !on;
        sw.setAttribute('aria-checked', String(on));
      }, 50));
      document.getElementById('done').addEventListener('click', () => {
        d.remove();
        document.getElementById('open').textContent = on ? 'On' : 'Off';
      });
    });
    window.__isOn = () => on;
  </script>
</body></html>`;
}

const WELL_KNOWN = {
  version: 1,
  name: 'ChatGPT (test)',
  trains_on_user_content: 'yes',
  default: 'opted_in',
  opt_out_url: 'https://chatgpt.com/#settings/DataControls',
  last_updated: '2026-09-01',
  unknown_field: 'ignored',
};

/** Serves chatgpt.com from the mock; `state.on` controls the toggle's initial state. */
function mockChatgpt(fakeSites, state = { on: true }) {
  fakeSites.set('chatgpt.com', ({ url }) => {
    if (url.pathname === '/.well-known/ai-training-opt-out') {
      return { contentType: 'application/json', body: JSON.stringify(WELL_KNOWN) };
    }
    if (url.pathname !== '/') return { status: 404, body: 'not found' };
    return { body: chatgptPage(state) };
  });
}

// ---------------------------------------------------------------------------
// Fixtures

const grantedTest = test.extend({
  extensionDir: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notrain-e2e-'));
      fs.cpSync(EXTENSION_DIR, dir, { recursive: true });
      const manifestPath = path.join(dir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const granted = ['https://chatgpt.com/*'];
      manifest.host_permissions = granted;
      manifest.optional_host_permissions = manifest.optional_host_permissions.filter(
        (p) => !granted.includes(p),
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      await use(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});

/** An extension page used to talk to the background like the UI does. */
async function uiPage(openExtensionPage) {
  const page = await openExtensionPage('popup/popup.html');
  const send = async (message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const call = async (message) => {
    const res = await send(message);
    expect(res, `${message.type} response`).toBeTruthy();
    expect(res.error, `${message.type} error`).toBeUndefined();
    expect(res.ok).toBe(true);
    return res.data;
  };
  return { page, send, call, state: () => call({ type: 'getState' }) };
}

function optOutRecord(state, serviceId = 'chatgpt', optOutId = TOGGLE) {
  return state.userState.services[serviceId]?.optOuts?.[optOutId] ?? null;
}

// ---------------------------------------------------------------------------

test.describe('background basics', () => {
  test('starts with the bundled registry and default settings', async ({ openExtensionPage }) => {
    const ui = await uiPage(openExtensionPage);
    const state = await ui.state();
    expect(state.registry.formatVersion).toBe(1);
    expect(state.registry.services.map((s) => s.id)).toEqual(BUNDLED.services.map((s) => s.id));
    expect(state.registryMeta).toMatchObject({ source: 'bundled', generatedAt: BUNDLED.generatedAt });
    expect(state.settings).toMatchObject({
      schemaVersion: 1,
      onboarded: false,
      region: 'OTHER',
      notifications: { policyChanges: true, flipBacks: true, reminders: true },
      autoSync: true,
      passiveChecks: true,
    });
    expect(state.userState).toEqual({ services: {} });
    expect(state.alerts).toEqual([]);
    expect(state.history).toEqual([]);
  });

  test('opens onboarding on install and schedules its alarms', async ({ context, serviceWorker }) => {
    await expect
      .poll(() => context.pages().some((p) => p.url().endsWith('/dashboard/dashboard.html#/welcome')))
      .toBe(true);
    const alarms = await serviceWorker.evaluate(async () =>
      (await chrome.alarms.getAll()).map((a) => a.name).sort(),
    );
    expect(alarms).toEqual(['notrain-registry-sync', 'notrain-reminders']);
  });

  test('rejects unknown types and invalid payloads', async ({ openExtensionPage }) => {
    const ui = await uiPage(openExtensionPage);
    expect(await ui.send({ type: 'nope' })).toEqual({ ok: false, error: 'Unknown message type "nope"' });
    const bad = await ui.send({ type: 'trackServices', serviceIds: ['not-a-service'], tracked: true });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Unknown service/);
    const badStatus = await ui.send({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'x',
    });
    expect(badStatus.ok).toBe(false);
    const badSettings = await ui.send({ type: 'updateSettings', patch: { region: 'Atlantis' } });
    expect(badSettings.ok).toBe(false);
  });

  test('track, untrack and update settings', async ({ openExtensionPage }) => {
    const ui = await uiPage(openExtensionPage);
    const ids = BUNDLED.services.slice(0, 2).map((s) => s.id);
    const tracked = await ui.call({
      type: 'trackServices',
      serviceIds: ids,
      tracked: true,
      source: 'manual',
    });
    for (const id of ids) {
      expect(tracked.services[id]).toMatchObject({ tracked: true, source: 'manual' });
      const service = BUNDLED.services.find((s) => s.id === id);
      expect(tracked.services[id].knownPolicyVersion).toBe(service.policyVersion);
    }
    const untracked = await ui.call({ type: 'trackServices', serviceIds: [ids[1]], tracked: false });
    expect(untracked.services[ids[1]].tracked).toBe(false);
    expect(untracked.services[ids[0]].tracked).toBe(true);

    const settings = await ui.call({
      type: 'updateSettings',
      patch: { region: 'EU', notifications: { reminders: false }, profile: { fullName: 'Ada Lovelace' } },
    });
    expect(settings.region).toBe('EU');
    expect(settings.notifications).toEqual({ policyChanges: true, flipBacks: true, reminders: false });
    expect((await ui.state()).settings.profile.fullName).toBe('Ada Lovelace');
  });

  test('setOptOutStatus records status and history; the badge follows attention items', async ({
    openExtensionPage,
  }) => {
    const ui = await uiPage(openExtensionPage);
    const u = await ui.call({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'done',
      method: 'manual',
      note: 'Done on my phone',
    });
    expect(u.services.chatgpt.tracked).toBe(true);
    expect(optOutRecord({ userState: u })).toMatchObject({
      status: 'done',
      method: 'manual',
      note: 'Done on my phone',
    });
    const state = await ui.state();
    expect(state.history[0]).toMatchObject({
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      action: 'manual',
      outcome: 'done',
    });

    const badge = () => ui.page.evaluate(() => chrome.action.getBadgeText({}));
    await ui.call({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'needs_attention',
      method: 'auto',
    });
    await expect.poll(badge).toBe('1');
    await ui.call({
      type: 'setOptOutStatus',
      serviceId: 'chatgpt',
      optOutId: TOGGLE,
      status: 'done',
      method: 'auto',
    });
    await expect.poll(badge).toBe('');
  });

  test('export → reset → import round-trips user data and keeps the bundled registry', async ({
    openExtensionPage,
  }) => {
    const ui = await uiPage(openExtensionPage);
    await ui.call({ type: 'updateSettings', patch: { region: 'UK', onboarded: true } });
    await ui.call({ type: 'recordLetter', serviceId: 'chatgpt', optOutId: 'privacy-portal-do-not-train' });
    const backup = await ui.call({ type: 'exportData' });
    expect(backup).toMatchObject({ app: 'NoTrain', schemaVersion: 1 });
    expect(Object.keys(backup).sort()).toEqual(
      [
        'alerts',
        'app',
        'exportedAt',
        'extensionVersion',
        'history',
        'schemaVersion',
        'settings',
        'userState',
      ].sort(),
    );

    expect(await ui.call({ type: 'resetAll' })).toBe(true);
    const reset = await ui.state();
    expect(reset.settings.region).toBe('OTHER');
    expect(reset.settings.onboarded).toBe(false);
    expect(reset.userState).toEqual({ services: {} });
    expect(reset.history).toEqual([]);
    expect(reset.registry.services.length).toBe(BUNDLED.services.length);

    const invalid = await ui.send({ type: 'importData', data: { ...backup, app: 'Other' } });
    expect(invalid.ok).toBe(false);

    const restored = await ui.call({ type: 'importData', data: backup });
    expect(restored.settings.region).toBe('UK');
    const after = await ui.state();
    expect(after.userState).toEqual(backup.userState);
    expect(after.history).toEqual(backup.history);
    expect(optOutRecord(after, 'chatgpt', 'privacy-portal-do-not-train')).toMatchObject({
      status: 'sent',
      method: 'letter',
    });
  });

  test('runOptOut without the host permission opens the page and reports no_permission', async ({
    context,
    fakeSites,
    openExtensionPage,
  }) => {
    mockChatgpt(fakeSites);
    const ui = await uiPage(openExtensionPage);
    const opened = waitForPageUrl(context, 'https://chatgpt.com/');
    const r = await ui.call({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
    expect(r).toMatchObject({ injected: false, reason: 'no_permission' });
    expect(typeof r.runId).toBe('string');
    expect(Number.isInteger(r.tabId)).toBe(true);
    const tab = await opened;
    expect(tab.url()).toBe(CHATGPT.optOuts.find((o) => o.id === TOGGLE).url);
    const bad = await ui.send({
      type: 'runOptOut',
      serviceId: 'chatgpt',
      optOutId: 'privacy-portal-do-not-train',
      mode: 'auto',
    });
    expect(bad.ok).toBe(false);
  });

  test('registry sync: newer remote data is applied and alerts tracked services', async ({
    context,
    openExtensionPage,
  }) => {
    const remote = structuredClone(BUNDLED);
    remote.generatedAt = new Date().toISOString();
    const svc = remote.services.find((s) => s.id === 'chatgpt');
    svc.policyVersion += 1;
    svc.changelog.push({
      version: svc.policyVersion,
      date: new Date().toISOString().slice(0, 10),
      summary: 'Voice conversations are now used for training by default.',
      severity: 'warning',
    });
    remote.services.push({ ...structuredClone(svc), id: 'brand-new-service', name: 'Brand New Service' });
    await context.route(REMOTE_REGISTRY, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(remote) }),
    );

    const ui = await uiPage(openExtensionPage);
    await ui.call({ type: 'trackServices', serviceIds: ['chatgpt'], tracked: true });
    const meta = await ui.call({ type: 'syncRegistry', force: true });
    expect(meta).toMatchObject({ source: 'remote', lastSyncStatus: 'ok', generatedAt: remote.generatedAt });
    const state = await ui.state();
    expect(state.registry.services.some((s) => s.id === 'brand-new-service')).toBe(true);
    expect(state.alerts.map((a) => a.kind).sort()).toEqual(['new_service', 'policy_change']);
    const policy = state.alerts.find((a) => a.kind === 'policy_change');
    expect(policy).toMatchObject({ serviceId: 'chatgpt', severity: 'warning', read: false });
    await expect.poll(() => ui.page.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

    await ui.call({ type: 'acknowledgePolicy', serviceId: 'chatgpt' });
    const acked = await ui.state();
    expect(acked.userState.services.chatgpt.knownPolicyVersion).toBe(svc.policyVersion);
    expect(acked.alerts.find((a) => a.kind === 'policy_change').read).toBe(true);
    await expect.poll(() => ui.page.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  });

  test('registry sync offline: records the error and keeps the cache', async ({
    context,
    openExtensionPage,
  }) => {
    await context.route(REMOTE_REGISTRY, (route) => route.abort('internetdisconnected'));
    const ui = await uiPage(openExtensionPage);
    const meta = await ui.call({ type: 'syncRegistry', force: true });
    expect(meta.lastSyncStatus).toBe('error');
    expect(meta.source).toBe('bundled');
    expect(typeof meta.lastError).toBe('string');
    expect((await ui.state()).registry.generatedAt).toBe(BUNDLED.generatedAt);
  });
});

grantedTest.describe('with the chatgpt.com permission granted', () => {
  grantedTest('probeWellKnown finds and validates the document', async ({ openExtensionPage, fakeSites }) => {
    mockChatgpt(fakeSites);
    const ui = await uiPage(openExtensionPage);
    const tabId = await ui.page.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
      await new Promise((resolve) => {
        const listener = (id, info) => {
          if (id === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      return tab.id;
    });
    const r = await ui.call({ type: 'probeWellKnown', tabId });
    expect(r.found).toBe(true);
    expect(r.url).toBe('https://chatgpt.com/.well-known/ai-training-opt-out');
    expect(r.document).toEqual({ ...WELL_KNOWN, unknown_field: undefined });

    const extTab = await ui.page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const restricted = await ui.call({ type: 'probeWellKnown', tabId: extTab });
    expect(restricted.found).toBe(false);
  });

  grantedTest(
    'one-click opt-out runs end to end on the mock page',
    async ({ context, openExtensionPage, fakeSites }) => {
      grantedTest.skip(
        !HAS_CONTENT_SCRIPTS,
        'content/engine.js and content/overlay.js are not available yet',
      );
      mockChatgpt(fakeSites, { on: true });
      const ui = await uiPage(openExtensionPage);
      const opened = waitForPageUrl(context, 'https://chatgpt.com/');
      const r = await ui.call({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
      expect(r).toMatchObject({ injected: true });
      expect(r.reason).toBeUndefined();
      const tab = await opened;

      await expect.poll(async () => optOutRecord(await ui.state())?.status, { timeout: 30_000 }).toBe('done');
      const state = await ui.state();
      const rec = optOutRecord(state);
      expect(rec.method).toBe('auto');
      expect(rec.verifiedAt).toBeTruthy();
      expect(['success', 'already']).toContain(rec.lastOutcome);
      expect(state.userState.services.chatgpt.tracked).toBe(true);
      expect(state.history[0]).toMatchObject({ serviceId: 'chatgpt', optOutId: TOGGLE, action: 'auto' });
      expect(await tab.evaluate(() => window.__isOn())).toBe(false);
    },
  );

  grantedTest(
    'verify mode detects a setting that flipped back on',
    async ({ openExtensionPage, fakeSites }) => {
      grantedTest.skip(
        !HAS_CONTENT_SCRIPTS,
        'content/engine.js and content/overlay.js are not available yet',
      );
      mockChatgpt(fakeSites, { on: true });
      const ui = await uiPage(openExtensionPage);
      await ui.call({
        type: 'setOptOutStatus',
        serviceId: 'chatgpt',
        optOutId: TOGGLE,
        status: 'done',
        method: 'auto',
      });
      const r = await ui.call({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'verify' });
      expect(r.injected).toBe(true);
      await expect
        .poll(async () => optOutRecord(await ui.state())?.status, { timeout: 30_000 })
        .toBe('needs_attention');
      const state = await ui.state();
      expect(state.alerts[0]).toMatchObject({ kind: 'flip_back', serviceId: 'chatgpt', optOutId: TOGGLE });
      await expect.poll(() => ui.page.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');
    },
  );

  grantedTest(
    'a run whose tab is redirected away is not injected',
    async ({ openExtensionPage, fakeSites }) => {
      fakeSites.set('chatgpt.com', () => ({
        status: 302,
        headers: { location: 'https://auth.example.test/login' },
      }));
      fakeSites.set('auth.example.test', () => ({ body: '<h1>Log in</h1>' }));
      const ui = await uiPage(openExtensionPage);
      const r = await ui.call({ type: 'runOptOut', serviceId: 'chatgpt', optOutId: TOGGLE, mode: 'auto' });
      expect(r).toMatchObject({ injected: false, reason: 'navigated_away' });
    },
  );
});
