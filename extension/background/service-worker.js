// NoTrain background (MV3 service worker; Firefox runs it as a module
// background script). The worker can be stopped and restarted at any time,
// so every listener is registered synchronously at the top level and no
// state is kept in memory between events: everything lives in
// chrome.storage.local (user data) or chrome.storage.session (in-flight runs).

import { handleMessage } from './router.js';
import {
  ensureReady,
  handleAlarm,
  handleInstalled,
  handleStartup,
  handleStorageChanged,
  scheduleBadgeUpdate,
} from './lifecycle.js';
import { forgetTab } from '../lib/runner.js';
import { recordPermissionGrant, recordPermissionRemoval } from '../lib/detection.js';
import { syncPassiveRegistrations } from '../lib/passive.js';
import { handleNotificationClick } from '../lib/notify.js';

const chrome = globalThis.chrome;

function logError(label) {
  return (err) => console.error(`NoTrain: ${label} failed`, err);
}

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch(logError('install'));
});

chrome.runtime.onStartup.addListener(() => {
  handleStartup().catch(logError('startup'));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .catch((err) => ({ ok: false, error: `Internal error: ${err?.message ?? err}` }))
    .then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  handleAlarm(alarm).catch(logError('alarm'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  handleStorageChanged(changes, area).catch(logError('state change'));
});

chrome.permissions?.onAdded?.addListener((added) => {
  Promise.all([recordPermissionGrant(added), ensureReady().then(syncPassiveRegistrations)]).catch(
    logError('permission grant'),
  );
});

chrome.permissions?.onRemoved?.addListener((removed) => {
  Promise.all([recordPermissionRemoval(removed), ensureReady().then(syncPassiveRegistrations)]).catch(
    logError('permission removal'),
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId).catch(logError('tab cleanup'));
});

chrome.notifications?.onClicked?.addListener((id) => {
  handleNotificationClick(id).catch(logError('notification click'));
});

// Any worker start (including after being stopped while idle) refreshes the badge.
ensureReady().then(scheduleBadgeUpdate).catch(logError('initialisation'));
