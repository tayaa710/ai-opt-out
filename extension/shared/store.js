// Page-level state store. Loads the full state from the background (retrying
// while the service worker starts up), re-loads when chrome.storage changes,
// and notifies subscribers. The background can restart at any time, so every
// failure is surfaced as an error state the page can recover from.

import { api, onStateChange } from '../lib/api.js';

const RETRY_DELAYS = [0, 150, 400, 900, 1800];

/**
 * @typedef {{ registry: object, registryMeta: object, settings: object, userState: object, alerts: object[], history: object[] }} AppState
 * @typedef {{ status: 'loading'|'ready'|'error', state: AppState|null, error: Error|null }} Snapshot
 */

export function createStore() {
  /** @type {Snapshot} */
  let snap = { status: 'loading', state: null, error: null };
  const subs = new Set();
  let loading = null;
  let queued = false;
  let unsubscribeStorage = null;

  const emit = () => {
    for (const fn of subs) {
      try {
        fn(snap);
      } catch (err) {
        console.error('[NoTrain] render failed', err);
      }
    }
  };

  async function fetchWithRetry() {
    let lastErr = null;
    for (const delay of RETRY_DELAYS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const state = await api.getState();
        if (!state || typeof state !== 'object') throw new Error('Empty state');
        return normalise(state);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('Could not load NoTrain');
  }

  async function load() {
    if (loading) {
      queued = true;
      return loading;
    }
    loading = (async () => {
      try {
        const state = await fetchWithRetry();
        snap = { status: 'ready', state, error: null };
      } catch (err) {
        // Keep showing the last good state if we have one.
        snap = snap.state ? { ...snap, error: err } : { status: 'error', state: null, error: err };
      }
      emit();
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
    if (queued) {
      queued = false;
      await load();
    }
  }

  let debounce = null;
  function start() {
    if (!unsubscribeStorage) {
      unsubscribeStorage = onStateChange(() => {
        clearTimeout(debounce);
        debounce = setTimeout(load, 60);
      });
    }
    return load();
  }

  return {
    start,
    reload: load,
    get: () => snap,
    get state() {
      return snap.state;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    stop() {
      unsubscribeStorage?.();
      unsubscribeStorage = null;
    },
  };
}

/** Fill in missing pieces so views never need defensive checks everywhere. */
function normalise(state) {
  const registry = state.registry && Array.isArray(state.registry.services) ? state.registry : { services: [], crawlers: [] };
  const services = registry.services.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string');
  return {
    registry: { ...registry, services, crawlers: Array.isArray(registry.crawlers) ? registry.crawlers : [] },
    registryMeta: state.registryMeta ?? {},
    settings: {
      region: 'OTHER',
      onboarded: false,
      notifications: {},
      profile: {},
      ...(state.settings ?? {}),
    },
    userState: { services: {}, ...(state.userState ?? {}) },
    alerts: Array.isArray(state.alerts) ? state.alerts : [],
    history: Array.isArray(state.history) ? state.history : [],
  };
}
