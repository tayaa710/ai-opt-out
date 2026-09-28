// In-memory chrome.* for unit-testing background modules in Node.
//
//   const mock = installChromeMock({ registry });
//   ... exercise modules that use globalThis.chrome ...
//   mock.uninstall();
//
// Covers storage.local/session (+ onChanged), alarms, notifications, action,
// runtime, permissions (+ onAdded/onRemoved), cookies, scripting (execute +
// registered content scripts), tabs (+ onUpdated/onRemoved) and windows, plus
// a fetch stub for extension URLs and the remote registry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patternCovers } from '../../../extension/lib/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
export const REAL_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXTENSION_BASE = `chrome-extension://${EXTENSION_ID}/`;

export function createEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
    get size() {
      return listeners.size;
    },
    dispatch: (...args) => [...listeners].map((fn) => fn(...args)),
  };
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function createStorageArea(areaName, onChanged) {
  const data = new Map();
  const area = {
    async get(keys) {
      const out = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = clone(v);
        return out;
      }
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      }
      for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : dflt;
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        // chrome.storage serialises values as JSON.
        const stored = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
        changes[k] = { oldValue: clone(data.get(k)), newValue: clone(stored) };
        data.set(k, stored);
      }
      area.writes += 1;
      onChanged.dispatch(changes, areaName);
    },
    async remove(keys) {
      const changes = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: clone(data.get(k)) };
        data.delete(k);
      }
      if (Object.keys(changes).length) onChanged.dispatch(changes, areaName);
    },
    async clear() {
      const changes = {};
      for (const [k, v] of data) changes[k] = { oldValue: clone(v) };
      data.clear();
      if (Object.keys(changes).length) onChanged.dispatch(changes, areaName);
    },
    /** Test helper: synchronous snapshot of everything stored. */
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, clone(v)])),
    writes: 0,
  };
  return area;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * @param {{
 *   manifest?: object,
 *   registry?: object|null,          // served at data/registry.json (null → 404)
 *   grantedOrigins?: string[],       // optional host permissions already granted
 *   grantedPermissions?: string[],   // optional API permissions already granted
 *   cookies?: { url: string, name: string, value?: string }[],
 *   autoCompleteTabs?: boolean,      // tabs finish loading on their own (default true)
 *   iconExists?: boolean,
 *   fetchRoutes?: Record<string, (url: string, init: object) => Response | Promise<Response>>,
 * }} [options]
 */
export function installChromeMock(options = {}) {
  const manifest = clone(options.manifest ?? REAL_MANIFEST);
  const storageChanged = createEvent();
  const granted = {
    permissions: new Set([...(manifest.permissions ?? []), ...(options.grantedPermissions ?? [])]),
    origins: new Set([...(manifest.host_permissions ?? []), ...(options.grantedOrigins ?? [])]),
  };
  const permissionsAdded = createEvent();
  const permissionsRemoved = createEvent();

  const tabsMap = new Map();
  let nextTabId = 100;
  const tabsUpdated = createEvent();
  const tabsRemoved = createEvent();
  const tabsCreated = createEvent();

  const alarmsMap = new Map();
  const cookieJar = new Map();
  for (const c of options.cookies ?? []) cookieJar.set(`${new URL(c.url).origin}|${c.name}`, c.value ?? 'secret');

  const registered = new Map();
  const notifications = new Map();
  const badge = { text: '', color: null, textColor: null, title: null };

  const mock = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: (p) => `${EXTENSION_BASE}${String(p).replace(/^\//, '')}`,
      getManifest: () => clone(manifest),
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
      sendMessage: async () => undefined,
    },
    storage: {
      onChanged: storageChanged,
      local: createStorageArea('local', storageChanged),
      session: createStorageArea('session', storageChanged),
    },
    alarms: {
      async create(name, info = {}) {
        alarmsMap.set(name, {
          name,
          scheduledTime: Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
          ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}),
        });
        mock.alarms.createCalls += 1;
      },
      async get(name) {
        return clone(alarmsMap.get(name));
      },
      async getAll() {
        return [...alarmsMap.values()].map(clone);
      },
      async clear(name) {
        return alarmsMap.delete(name);
      },
      async clearAll() {
        alarmsMap.clear();
        return true;
      },
      onAlarm: createEvent(),
      createCalls: 0,
    },
    notifications: {
      create(id, opts, cb) {
        if (mock.notifications.failIcon && !String(opts.iconUrl).startsWith('data:')) {
          mock.runtime.lastError = { message: 'Unable to download all specified images.' };
          cb?.(undefined);
          mock.runtime.lastError = undefined;
          return;
        }
        notifications.set(id, clone(opts));
        cb?.(id);
      },
      clear(id, cb) {
        const had = notifications.delete(id);
        cb?.(had);
      },
      onClicked: createEvent(),
      failIcon: false,
      shown: notifications,
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
      async setBadgeTextColor({ color }) {
        badge.textColor = color;
      },
      async setTitle({ title }) {
        badge.title = title;
      },
      badge,
    },
    permissions: {
      async contains({ permissions = [], origins = [] } = {}) {
        return (
          permissions.every((p) => granted.permissions.has(p)) &&
          origins.every((o) => [...granted.origins].some((g) => patternCovers(g, o)))
        );
      },
      async getAll() {
        return { permissions: [...granted.permissions], origins: [...granted.origins] };
      },
      async request({ permissions = [], origins = [] } = {}) {
        return mock.grant({ permissions, origins });
      },
      async remove({ permissions = [], origins = [] } = {}) {
        const removed = { permissions: [], origins: [] };
        for (const p of permissions) {
          if ((manifest.permissions ?? []).includes(p)) throw new Error('You cannot remove required permissions.');
          if (granted.permissions.delete(p)) removed.permissions.push(p);
        }
        for (const o of origins) if (granted.origins.delete(o)) removed.origins.push(o);
        mock.permissions.removeCalls.push({ permissions, origins });
        if (removed.permissions.length || removed.origins.length) permissionsRemoved.dispatch(removed);
        return true;
      },
      onAdded: permissionsAdded,
      onRemoved: permissionsRemoved,
      removeCalls: [],
    },
    cookies: {
      async get({ url, name }) {
        const key = `${new URL(url).origin}|${name}`;
        if (!cookieJar.has(key)) return null;
        return { name, value: cookieJar.get(key), domain: new URL(url).hostname, path: '/' };
      },
    },
    scripting: {
      calls: [],
      /** Replace to simulate page behaviour: (details) => InjectionResult[] */
      executeImpl: null,
      async executeScript(details) {
        mock.scripting.calls.push(clone({ ...details, func: details.func?.name }));
        const tab = tabsMap.get(details.target.tabId);
        if (!tab) throw new Error(`No tab with id: ${details.target.tabId}`);
        if (mock.scripting.executeImpl) return mock.scripting.executeImpl(details, tab);
        if (details.files) return [{ frameId: 0, documentId: 'doc-1', result: null }];
        return [{ frameId: 0, documentId: 'doc-1', result: null }];
      },
      missingFiles: [],
      rejectPersist: false,
      async registerContentScripts(scripts) {
        for (const s of scripts) {
          if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
          const missing = (s.js ?? []).find((f) => mock.scripting.missingFiles.includes(f));
          if (missing) throw new Error(`Could not load javascript '${missing}' for script.`);
          if (mock.scripting.rejectPersist && s.persistAcrossSessions) {
            throw new Error('persistAcrossSessions is not supported');
          }
        }
        for (const s of scripts) registered.set(s.id, clone(s));
      },
      async getRegisteredContentScripts(filter = {}) {
        return [...registered.values()].filter((s) => !filter.ids || filter.ids.includes(s.id)).map(clone);
      },
      async unregisterContentScripts(filter = {}) {
        const ids = filter.ids ?? [...registered.keys()];
        for (const id of ids) {
          if (!registered.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        }
        for (const id of ids) registered.delete(id);
      },
      registered,
    },
    tabs: {
      created: [],
      async create({ url, active = true } = {}) {
        const tab = { id: nextTabId++, windowId: 1, url: '', pendingUrl: url, status: 'loading', active };
        tabsMap.set(tab.id, tab);
        mock.tabs.created.push({ id: tab.id, url });
        tabsCreated.dispatch(clone(tab));
        if (options.autoCompleteTabs !== false) setTimeout(() => mock.completeTab(tab.id, url), 0);
        return clone(tab);
      },
      async get(tabId) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return clone(tab);
      },
      async update(tabId, props) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        Object.assign(tab, props);
        return clone(tab);
      },
      async remove(tabId) {
        mock.closeTab(tabId);
      },
      async query() {
        return [...tabsMap.values()].map(clone);
      },
      onUpdated: tabsUpdated,
      onRemoved: tabsRemoved,
      onCreated: tabsCreated,
    },
    windows: {
      async update() {
        return {};
      },
    },

    // ---- test controls ----
    /** Simulates a granted permissions.request (fires onAdded with only the new items). */
    grant({ permissions = [], origins = [] } = {}) {
      const added = { permissions: [], origins: [] };
      for (const p of permissions) {
        if (!granted.permissions.has(p)) {
          granted.permissions.add(p);
          added.permissions.push(p);
        }
      }
      for (const o of origins) {
        if (!granted.origins.has(o)) {
          granted.origins.add(o);
          added.origins.push(o);
        }
      }
      if (added.permissions.length || added.origins.length) permissionsAdded.dispatch(added);
      return true;
    },
    /** Grants silently (as if granted before the test started). */
    preGrant({ permissions = [], origins = [] } = {}) {
      for (const p of permissions) granted.permissions.add(p);
      for (const o of origins) granted.origins.add(o);
    },
    granted,
    completeTab(tabId, url) {
      const tab = tabsMap.get(tabId);
      if (!tab) return;
      tab.url = url ?? tab.pendingUrl ?? tab.url;
      delete tab.pendingUrl;
      tab.status = 'complete';
      tabsUpdated.dispatch(tabId, { status: 'complete' }, clone(tab));
    },
    navigateTab(tabId, url) {
      const tab = tabsMap.get(tabId);
      if (!tab) return;
      tab.url = url;
    },
    closeTab(tabId) {
      if (!tabsMap.delete(tabId)) return;
      tabsRemoved.dispatch(tabId, { windowId: 1, isWindowClosing: false });
    },
    tabsMap,
    alarmsMap,
    cookieJar,
    fetchCalls: [],
    fetchRoutes: { ...(options.fetchRoutes ?? {}) },
    registryBody: options.registry === undefined ? null : options.registry,
    iconExists: options.iconExists ?? true,
    uninstall() {
      globalThis.fetch = originalFetch;
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    },
  };

  const originalFetch = globalThis.fetch;
  const previousChrome = globalThis.chrome;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    mock.fetchCalls.push({ url, init });
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (mock.fetchRoutes[url]) return mock.fetchRoutes[url](url, init);
    if (url === `${EXTENSION_BASE}data/registry.json`) {
      if (mock.registryBody === null) return new Response('Not found', { status: 404 });
      return jsonResponse(mock.registryBody);
    }
    if (url === `${EXTENSION_BASE}icons/icon-128.png`) {
      return mock.iconExists ? new Response('png', { status: 200 }) : new Response('', { status: 404 });
    }
    throw new TypeError(`fetch failed (no mock route for ${url})`);
  };
  globalThis.chrome = mock;
  return mock;
}

export { jsonResponse };

/** Waits for pending timers/microtasks (e.g. auto-completing tabs). */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sender objects as chrome.runtime.onMessage would provide them. */
export const senders = {
  popup: () => ({ id: EXTENSION_ID, url: `${EXTENSION_BASE}popup/popup.html`, origin: EXTENSION_BASE.slice(0, -1) }),
  dashboard: () => ({
    id: EXTENSION_ID,
    url: `${EXTENSION_BASE}dashboard/dashboard.html#/overview`,
    tab: { id: 7, url: `${EXTENSION_BASE}dashboard/dashboard.html` },
    frameId: 0,
  }),
  content: (tabId, url, frameId = 0) => ({ id: EXTENSION_ID, url, tab: { id: tabId, url }, frameId }),
  otherExtension: () => ({ id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzz/page.html' }),
};
