// Opt-out runs (ARCHITECTURE.md "Opt-out run flow"). A run opens the opt-out's
// deep link in a new tab and, if the user granted the host permission, injects
// the bundled engine + overlay which then report back with runProgress /
// runResult / guidedDone messages. Run bookkeeping lives in
// chrome.storage.session because the service worker can be restarted at any
// moment while the user is working in the tab.

import { OPT_OUT_STATUS, RUN_OUTCOMES, STORAGE_KEYS } from './constants.js';
import {
  OUTCOME_VALUES,
  SESSION_KEYS,
  UserError,
  newId,
  readLocal,
  readSession,
  updateLocal,
  updateSession,
} from './storage.js';
import { allowedHostPatterns, hasPermissions, urlMatchesAny } from './permissions.js';
import { applyRunOutcome, requireServiceOptOut, setOptOutStatus } from './user-state.js';
import { appendHistory, makeHistoryEntry } from './history.js';
import { flipBackAlert, mergeAlerts } from './alerts.js';
import { notify } from './notify.js';

export const RUN_MODES = Object.freeze(['auto', 'guided', 'verify']);
export const CONTENT_FILES = Object.freeze(['content/engine.js', 'content/overlay.js']);
export const TAB_LOAD_TIMEOUT_MS = 30_000;
export const RUN_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_RUNS = 20;
const MESSAGE_MAX = 500;

/** Reasons returned as `{ injected: false, reason }`. */
export const NOT_INJECTED = Object.freeze({
  noAutomation: 'no_automation', // opt-out has no recipe; UI shows the steps
  notAllowed: 'not_allowed', // recipe names hosts the manifest does not declare
  noPermission: 'no_permission', // user has not granted the host permission
  tabClosed: 'tab_closed',
  navigatedAway: 'navigated_away', // e.g. redirected to a login page on another host
  injectionFailed: 'injection_failed',
});

const K = STORAGE_KEYS;

/**
 * @throws {UserError} if the mode cannot be used for this opt-out
 */
export function checkRunnable(optOut, mode) {
  if (!RUN_MODES.includes(mode)) throw new UserError('mode must be "auto", "guided" or "verify"');
  if (!optOut.url) throw new UserError(`“${optOut.title}” has no page to open`);
  if (mode !== 'guided' && !optOut.automation) throw new UserError(`“${optOut.title}” cannot be automated`);
  if (mode === 'verify' && !(optOut.automation.verify?.length > 0)) {
    throw new UserError(`“${optOut.title}” has no verification steps`);
  }
}

/** The config passed to NoTrainOverlay.start(). */
export function overlayConfig(runId, mode, service, optOut) {
  return {
    runId,
    mode,
    service: { id: service.id, name: service.name, company: service.company },
    optOut: {
      id: optOut.id,
      title: optOut.title,
      steps: optOut.steps,
      effect: optOut.effect,
      automation: optOut.automation ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Run bookkeeping (chrome.storage.session)

export function pruneRuns(runs, now = Date.now()) {
  const kept = Object.values(runs ?? {})
    .filter((r) => r && now - Date.parse(r.startedAt) < RUN_TTL_MS)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, MAX_RUNS);
  return Object.fromEntries(kept.map((r) => [r.runId, r]));
}

async function saveRun(run) {
  await updateSession(SESSION_KEYS.runs, {}, (runs) => ({
    value: { ...pruneRuns(runs), [run.runId]: run },
  }));
}

/** Applies `fn` to a stored run (no-op if it is gone). */
async function patchRun(runId, fn) {
  await updateSession(SESSION_KEYS.runs, {}, (runs) => {
    if (!runs[runId]) return undefined;
    return { value: { ...runs, [runId]: fn(runs[runId]) } };
  });
}

export async function getRun(runId) {
  const runs = await readSession(SESSION_KEYS.runs, {});
  return runs[runId] ?? null;
}

/** tabs.onRemoved: forget runs whose tab was closed. */
export async function forgetTab(tabId) {
  await updateSession(SESSION_KEYS.runs, {}, (runs) => {
    const left = Object.fromEntries(Object.entries(runs).filter(([, r]) => r.tabId !== tabId));
    return Object.keys(left).length === Object.keys(runs).length ? undefined : { value: left };
  });
}

// ---------------------------------------------------------------------------
// Tabs

class RunAbort extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Resolves when the tab finishes loading (or after `timeoutMs`, in which case
 * the run continues anyway), rejects with RunAbort('tab_closed') if it closes.
 */
export function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const tabs = globalThis.chrome.tabs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      tabs.onUpdated.removeListener(onUpdated);
      tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      fn(value);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(resolve, { timedOut: false });
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new RunAbort(NOT_INJECTED.tabClosed));
    };
    const timer = setTimeout(() => finish(resolve, { timedOut: true }), timeoutMs);
    tabs.onUpdated.addListener(onUpdated);
    tabs.onRemoved.addListener(onRemoved);
    // The tab may already be complete before the listeners were attached.
    tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete' && !tab.pendingUrl && tab.url && tab.url !== 'about:blank') {
          finish(resolve, { timedOut: false });
        }
      },
      () => finish(reject, new RunAbort(NOT_INJECTED.tabClosed)),
    );
  });
}

async function tabExists(tabId) {
  try {
    await globalThis.chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs inside the page (serialised by chrome.scripting, so it must be
 * self-contained). Re-checks the page host against the allowed patterns right
 * before starting, closing the gap between the URL check and injection, and
 * starts the overlay without waiting for the run to finish.
 * @param {object} cfg overlay config
 * @param {string[]} patterns allowed https://host/* patterns
 */
export function startOverlayInPage(cfg, patterns) {
  const host = location.hostname.toLowerCase();
  const allowed =
    location.protocol === 'https:' &&
    patterns.some((p) => {
      const m = /^https:\/\/([^/]+)\/\*$/.exec(p);
      if (!m) return false;
      const h = m[1];
      if (h === '*') return true;
      if (h.startsWith('*.')) return host === h.slice(2) || host.endsWith(h.slice(1));
      return host === h;
    });
  if (!allowed) return { started: false, reason: 'navigated_away' };
  const overlay = globalThis.NoTrainOverlay;
  if (!overlay || typeof overlay.start !== 'function') return { started: false, reason: 'injection_failed' };
  try {
    const pending = overlay.start(cfg);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    return { started: false, reason: 'injection_failed' };
  }
  return { started: true };
}

async function inject(run, cfg) {
  const scripting = globalThis.chrome.scripting;
  const { tabId } = run;
  try {
    const injected = await scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [...CONTENT_FILES] });
    // Pin the start call to the same document where supported (Chrome), so a
    // navigation in between cannot receive it.
    const documentId = injected?.[0]?.documentId;
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
    const [res] = await scripting.executeScript({ target, func: startOverlayInPage, args: [cfg, run.patterns] });
    if (!res?.result?.started) return { injected: false, reason: res?.result?.reason ?? NOT_INJECTED.injectionFailed };
    return { injected: true };
  } catch (err) {
    if (!(await tabExists(tabId))) return { injected: false, reason: NOT_INJECTED.tabClosed };
    console.warn('NoTrain: injection failed', err);
    return { injected: false, reason: NOT_INJECTED.injectionFailed };
  }
}

async function prepareAndInject(run, service, optOut, loadTimeoutMs) {
  if (!optOut.automation) return { injected: false, reason: NOT_INJECTED.noAutomation };
  if (run.patterns.length === 0) return { injected: false, reason: NOT_INJECTED.notAllowed };
  if (!(await hasPermissions({ origins: run.patterns }))) return { injected: false, reason: NOT_INJECTED.noPermission };
  try {
    await waitForTabComplete(run.tabId, loadTimeoutMs);
  } catch (err) {
    return { injected: false, reason: err.reason ?? NOT_INJECTED.tabClosed };
  }
  let tab;
  try {
    tab = await globalThis.chrome.tabs.get(run.tabId);
  } catch {
    return { injected: false, reason: NOT_INJECTED.tabClosed };
  }
  if (!tab.url || !urlMatchesAny(tab.url, run.patterns)) return { injected: false, reason: NOT_INJECTED.navigatedAway };
  await patchRun(run.runId, (r) => ({ ...r, phase: 'injecting' }));
  return inject(run, overlayConfig(run.runId, run.mode, service, optOut));
}

/**
 * Handles the `runOptOut` message.
 * @param {{ serviceId: string, optOutId: string, mode: string }} payload
 * @param {{ loadTimeoutMs?: number, now?: Date }} [options]
 * @returns {Promise<{ runId: string, tabId: number, injected: boolean, reason?: string }>}
 */
export async function runOptOut({ serviceId, optOutId, mode }, { loadTimeoutMs, now = new Date() } = {}) {
  const { registry } = await readLocal([K.registry]);
  const { service, optOut } = requireServiceOptOut(registry, serviceId, optOutId);
  checkRunnable(optOut, mode);
  const chrome = globalThis.chrome;
  const tab = await chrome.tabs.create({ url: optOut.url, active: true });
  if (tab.windowId !== undefined && chrome.windows?.update) {
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  const run = {
    runId: newId(),
    serviceId: service.id,
    optOutId: optOut.id,
    mode,
    tabId: tab.id,
    patterns: allowedHostPatterns(optOut),
    startedAt: now.toISOString(),
    phase: 'opening',
  };
  await saveRun(run);
  const result = await prepareAndInject(run, service, optOut, loadTimeoutMs);
  await patchRun(run.runId, (r) => {
    if (!result.injected) return { ...r, phase: 'not_injected', reason: result.reason };
    // A fast run may already have reported its result; never move backwards.
    return r.phase === 'injecting' ? { ...r, phase: 'running' } : r;
  });
  return {
    runId: run.runId,
    tabId: tab.id,
    injected: result.injected,
    ...(result.injected ? {} : { reason: result.reason }),
  };
}

// ---------------------------------------------------------------------------
// Reports from the in-page engine/overlay

const ACCEPTING = new Set(['injecting', 'running', 'finished']);

/**
 * Finds the run a content-script message belongs to and checks that it really
 * comes from the top frame of the tab this run opened, on an allowed host.
 * @throws {UserError}
 */
export async function runForSender(runId, sender) {
  if (typeof runId !== 'string' || runId.length > 100) throw new UserError('Unknown run');
  const run = await getRun(runId);
  if (!run || !ACCEPTING.has(run.phase)) throw new UserError('Unknown run');
  if (sender?.tab?.id !== run.tabId || (sender.frameId ?? 0) !== 0) throw new UserError('Run belongs to another tab');
  if (!urlMatchesAny(sender.url, run.patterns)) throw new UserError('Run belongs to another site');
  return run;
}

function checkIds(msg, run) {
  if (msg.serviceId !== undefined && msg.serviceId !== run.serviceId) throw new UserError('serviceId mismatch');
  if (msg.optOutId !== undefined && msg.optOutId !== run.optOutId) throw new UserError('optOutId mismatch');
}

/** `runProgress`: remembered on the run (session only). */
export async function handleRunProgress(msg, sender) {
  const run = await runForSender(msg.runId, sender);
  const { stepIndex, total } = msg;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 1000) throw new UserError('Invalid stepIndex');
  if (!Number.isInteger(total) || total < 0 || total > 1000) throw new UserError('Invalid total');
  const description = typeof msg.description === 'string' ? msg.description.slice(0, 200) : '';
  await patchRun(run.runId, (r) => ({ ...r, progress: { stepIndex, total, description } }));
  return { recorded: true };
}

/** `runResult`: updates userState, history and (for a flip-back) alerts. */
export async function handleRunResult(msg, sender, { now = new Date() } = {}) {
  const run = await runForSender(msg.runId, sender);
  checkIds(msg, run);
  if (msg.mode !== undefined && msg.mode !== run.mode) throw new UserError('mode mismatch');
  if (!OUTCOME_VALUES.includes(msg.outcome)) throw new UserError('Unknown outcome');
  const detail = typeof msg.message === 'string' ? msg.message.slice(0, MESSAGE_MAX) : undefined;
  const { flipAlert, notifyFlips } = await updateLocal(
    [K.registry, K.userState, K.history, K.alerts, K.settings],
    (v) => {
      const { service, optOut } = requireServiceOptOut(v[K.registry], run.serviceId, run.optOutId);
      const r = applyRunOutcome(v[K.userState], service, optOut, { mode: run.mode, outcome: msg.outcome }, now);
      const entry = makeHistoryEntry(
        { serviceId: service.id, optOutId: optOut.id, action: run.mode, outcome: msg.outcome, detail },
        now,
      );
      const set = { [K.userState]: r.userState, [K.history]: appendHistory(v[K.history], entry) };
      let alert = null;
      if (r.flipBack) {
        const merged = mergeAlerts(v[K.alerts], [flipBackAlert(service, optOut, 'verify', now)]);
        set[K.alerts] = merged.alerts;
        alert = merged.added[0] ?? null;
      }
      return { set, result: { flipAlert: alert, notifyFlips: v[K.settings].notifications.flipBacks } };
    },
  );
  await patchRun(run.runId, (r) => ({ ...r, phase: 'finished', outcome: msg.outcome }));
  if (flipAlert && notifyFlips) {
    await notify({ kind: flipAlert.kind, serviceId: flipAlert.serviceId, title: flipAlert.title, message: flipAlert.body });
  }
  return { recorded: true };
}

/** `guidedDone`: the user says they switched it off themselves. */
export async function handleGuidedDone(msg, sender, { now = new Date() } = {}) {
  const run = await runForSender(msg.runId, sender);
  checkIds(msg, run);
  await updateLocal([K.registry, K.userState, K.history], (v) => {
    const { service, optOut } = requireServiceOptOut(v[K.registry], run.serviceId, run.optOutId);
    const userState = setOptOutStatus(
      v[K.userState],
      service,
      optOut,
      { status: OPT_OUT_STATUS.done, method: 'guided' },
      now,
    );
    const entry = makeHistoryEntry(
      { serviceId: service.id, optOutId: optOut.id, action: 'guided', outcome: RUN_OUTCOMES.success },
      now,
    );
    return { set: { [K.userState]: userState, [K.history]: appendHistory(v[K.history], entry) } };
  });
  await patchRun(run.runId, (r) => ({ ...r, phase: 'finished', outcome: RUN_OUTCOMES.success }));
  return { recorded: true };
}
