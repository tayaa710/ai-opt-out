// Message router: checks who is asking, validates the payload, dispatches,
// and always answers `{ ok: true, data }` or `{ ok: false, error }`.
//
// Two kinds of senders are accepted:
// - "ui": extension pages of this extension (popup, dashboard);
// - "content": our content scripts, i.e. the top-level frame of an https tab.
//   Their handlers additionally check the message belongs to a run this
//   worker started in that tab, or to a passive check it registered for
//   that host.

import { METHODS, OPT_OUT_STATUS } from '../lib/constants.js';
import { SOURCES, UserError, isPlainObject } from '../lib/storage.js';
import { RUN_MODES, handleGuidedDone, handleRunProgress, handleRunResult, runOptOut } from '../lib/runner.js';
import { detectAccounts } from '../lib/detection.js';
import { syncRegistry } from '../lib/registry.js';
import { probeWellKnown } from '../lib/wellknown.js';
import { PASSIVE_STATES, getPassiveChecks, handlePassiveResult } from '../lib/passive.js';
import * as h from './handlers.js';
import { ensureReady } from './lifecycle.js';
import {
  expectBoolean,
  expectEnum,
  expectId,
  expectIdList,
  expectInt,
  expectObject,
  expectString,
  optionalNote,
} from './validate.js';

/**
 * @param {chrome.runtime.MessageSender | undefined} sender
 * @returns {'ui'|'content'|null}
 */
export function classifySender(sender) {
  const runtime = globalThis.chrome?.runtime;
  if (!sender || !runtime || sender.id !== runtime.id) return null;
  const url = typeof sender.url === 'string' ? sender.url : '';
  const base = runtime.getURL('');
  if (url.startsWith(base)) return 'ui';
  if (
    sender.tab &&
    Number.isInteger(sender.tab.id) &&
    url.startsWith('https://') &&
    (sender.frameId ?? 0) === 0
  ) {
    return 'content';
  }
  return null;
}

const ui = (handler) => ({ from: 'ui', handler });
const content = (handler) => ({ from: 'content', handler });
const STATUSES = Object.values(OPT_OUT_STATUS);

/** Every message type in ARCHITECTURE.md "Messaging" (plus content-script reports). */
export const ROUTES = Object.freeze({
  getState: ui(() => h.getState()),
  updateSettings: ui((m) => h.updateSettings({ patch: expectObject(m.patch, 'patch') })),
  trackServices: ui((m) =>
    h.track({
      serviceIds: expectIdList(m.serviceIds, 'serviceIds'),
      tracked: m.tracked === undefined ? true : expectBoolean(m.tracked, 'tracked'),
      source: m.source === undefined ? 'manual' : expectEnum(m.source, SOURCES, 'source'),
    }),
  ),
  setOptOutStatus: ui((m) =>
    h.setStatus({
      serviceId: expectId(m.serviceId, 'serviceId'),
      optOutId: expectId(m.optOutId, 'optOutId'),
      status: expectEnum(m.status, STATUSES, 'status'),
      method: m.method === undefined ? 'manual' : expectEnum(m.method, METHODS, 'method'),
      note: optionalNote(m.note),
    }),
  ),
  acknowledgePolicy: ui((m) => h.acknowledge({ serviceId: expectId(m.serviceId, 'serviceId') })),
  runOptOut: ui((m) =>
    runOptOut({
      serviceId: expectId(m.serviceId, 'serviceId'),
      optOutId: expectId(m.optOutId, 'optOutId'),
      mode: expectEnum(m.mode, RUN_MODES, 'mode'),
    }),
  ),
  detectAccounts: ui(() => detectAccounts()),
  syncRegistry: ui((m) =>
    syncRegistry({ force: m.force === undefined ? true : expectBoolean(m.force, 'force') }),
  ),
  markAlert: ui((m) =>
    h.markOneAlert({ id: expectString(m.id, 'id', 100), patch: expectObject(m.patch, 'patch') }),
  ),
  markAllAlertsRead: ui(() => h.markEveryAlertRead()),
  recordLetter: ui((m) =>
    h.recordLetter({
      serviceId: expectId(m.serviceId, 'serviceId'),
      optOutId: expectId(m.optOutId, 'optOutId'),
    }),
  ),
  probeWellKnown: ui((m) => probeWellKnown({ tabId: expectInt(m.tabId, 'tabId') })),
  exportData: ui(() => h.exportData()),
  importData: ui((m) => h.importData({ data: m.data })),
  resetAll: ui(() => h.resetAll()),

  runProgress: content((m, sender) => handleRunProgress(m, sender)),
  runResult: content((m, sender) => handleRunResult(m, sender)),
  guidedDone: content((m, sender) => handleGuidedDone(m, sender)),
  getPassiveChecks: content((m, sender) => getPassiveChecks(m, sender)),
  passiveCheckResult: content((m, sender) =>
    handlePassiveResult(
      {
        serviceId: expectId(m.serviceId, 'serviceId'),
        optOutId: expectId(m.optOutId, 'optOutId'),
        state: expectEnum(m.state, PASSIVE_STATES, 'state'),
      },
      sender,
    ),
  ),
});

/**
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
 */
export async function handleMessage(msg, sender) {
  try {
    if (!isPlainObject(msg) || typeof msg.type !== 'string') throw new UserError('Invalid message');
    const route = Object.hasOwn(ROUTES, msg.type) ? ROUTES[msg.type] : null;
    if (!route) throw new UserError(`Unknown message type "${msg.type.slice(0, 40)}"`);
    if (classifySender(sender) !== route.from)
      throw new UserError(`"${msg.type}" is not allowed from this sender`);
    await ensureReady();
    const data = await route.handler(msg, sender);
    return { ok: true, data: data === undefined ? null : data };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    console.error(`NoTrain: "${msg?.type}" failed`, err);
    return { ok: false, error: `Internal error: ${err?.message ?? String(err)}` };
  }
}
