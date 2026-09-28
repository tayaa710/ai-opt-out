// Client used by extension pages (popup, dashboard) to talk to the service
// worker. Every request resolves to `data` or rejects with an Error.
// The full message contract lives in ARCHITECTURE.md ("Messaging").

import { STORAGE_KEYS } from './constants.js';

/**
 * @param {string} type
 * @param {object} [payload]
 */
export async function send(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    throw new Error(`NoTrain background did not respond to "${type}": ${err?.message ?? err}`);
  }
  if (!res) throw new Error(`No response to "${type}"`);
  if (res.ok === false) throw new Error(res.error || `"${type}" failed`);
  return res.data;
}

export const api = Object.freeze({
  /** @returns {Promise<{registry: object, registryMeta: object, settings: object, userState: object, alerts: object[], history: object[]}>} */
  getState: () => send('getState'),
  updateSettings: (patch) => send('updateSettings', { patch }),
  trackServices: (serviceIds, tracked = true, source = 'manual') =>
    send('trackServices', { serviceIds, tracked, source }),
  setOptOutStatus: (serviceId, optOutId, status, method = 'manual', note) =>
    send('setOptOutStatus', { serviceId, optOutId, status, method, note }),
  acknowledgePolicy: (serviceId) => send('acknowledgePolicy', { serviceId }),
  /** mode: 'auto' | 'guided' | 'verify' */
  runOptOut: (serviceId, optOutId, mode) => send('runOptOut', { serviceId, optOutId, mode }),
  detectAccounts: () => send('detectAccounts'),
  syncRegistry: (force = true) => send('syncRegistry', { force }),
  markAlert: (id, patch) => send('markAlert', { id, patch }),
  markAllAlertsRead: () => send('markAllAlertsRead'),
  recordLetter: (serviceId, optOutId) => send('recordLetter', { serviceId, optOutId }),
  probeWellKnown: (tabId) => send('probeWellKnown', { tabId }),
  exportData: () => send('exportData'),
  importData: (data) => send('importData', { data }),
  resetAll: () => send('resetAll'),
});

/**
 * Host permissions must be requested from a user gesture in an extension page.
 * Call this directly inside a click handler, before awaiting anything else.
 * @param {string[]} origins match patterns, e.g. ['https://chatgpt.com/*']
 * @param {string[]} [permissions] e.g. ['cookies']
 * @returns {Promise<boolean>} granted
 */
export function requestPermissions(origins, permissions = []) {
  return chrome.permissions.request({ origins, permissions });
}

export function hasPermissions(origins, permissions = []) {
  return chrome.permissions.contains({ origins, permissions });
}

/**
 * Re-render when stored state changes (from any context).
 * @param {(changedKeys: string[]) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onStateChange(callback) {
  const watched = new Set(Object.values(STORAGE_KEYS));
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes).filter((k) => watched.has(k));
    if (keys.length) callback(keys);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
