// System notifications. The notification id encodes the service so a click
// can open the dashboard at the right place without any stored state (the
// service worker may have been restarted in between).

import { ID_PATTERN } from './storage.js';

export const ICON_PATH = 'icons/icon-128.png';
const PREFIX = 'notrain';
// 1×1 transparent PNG, used if the packaged icon is missing (Chrome refuses a
// "basic" notification whose icon cannot be loaded).
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Calls a callback-style chrome API and returns a promise (works in Chrome and Firefox). */
function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

let iconCheck = null;
async function iconUrl() {
  const url = globalThis.chrome.runtime.getURL(ICON_PATH);
  iconCheck ??= fetch(url)
    .then((r) => r.ok)
    .catch(() => false);
  return (await iconCheck) ? url : FALLBACK_ICON;
}

/** Test hook. */
export function _resetIconCheck() {
  iconCheck = null;
}

export function notificationId(kind, serviceId) {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  return `${PREFIX}:${kind}:${serviceId ?? ''}:${suffix}`;
}

/** @returns {{ kind: string, serviceId: string|null } | null} */
export function parseNotificationId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const serviceId = parts[2] && ID_PATTERN.test(parts[2]) ? parts[2] : null;
  return { kind: parts[1], serviceId };
}

/** Dashboard route for a notification. */
export function dashboardRouteFor(id) {
  const parsed = parseNotificationId(id);
  if (!parsed) return null;
  return parsed.serviceId ? `#/service/${parsed.serviceId}` : '#/alerts';
}

/**
 * Shows a basic notification. Never throws: notifications are best-effort.
 * @param {{ kind: string, serviceId?: string|null, title: string, message: string, priority?: number }} n
 * @returns {Promise<string|null>} the notification id, or null if not shown
 */
export async function notify({ kind, serviceId = null, title, message, priority = 1 }) {
  const api = globalThis.chrome?.notifications;
  if (!api?.create) return null;
  const id = notificationId(kind, serviceId);
  const options = {
    type: 'basic',
    title: String(title).slice(0, 120),
    message: String(message).slice(0, 400),
    priority,
    iconUrl: await iconUrl(),
  };
  try {
    await call(api.create.bind(api), id, options);
    return id;
  } catch {
    if (options.iconUrl === FALLBACK_ICON) return null;
    try {
      await call(api.create.bind(api), id, { ...options, iconUrl: FALLBACK_ICON });
      return id;
    } catch {
      return null;
    }
  }
}

/** notifications.onClicked handler: open the dashboard at the relevant place. */
export async function handleNotificationClick(id) {
  const route = dashboardRouteFor(id);
  if (!route) return;
  const chrome = globalThis.chrome;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${route}`) });
  } finally {
    try {
      await call(chrome.notifications.clear.bind(chrome.notifications), id);
    } catch {
      // Already gone.
    }
  }
}
