/*
 * NoTrain passive flip-back check.
 *
 * Classic content script, registered by the background (id
 * `notrain-passive-<serviceId>`) together with content/engine.js on the
 * pages of services the user already opted out of. See ARCHITECTURE.md
 * "Monitoring → Passive flip-back checks".
 *
 * Strictly read-only: it never clicks, types, scrolls, highlights or shows
 * anything. It asks the background which checks apply to this page, watches
 * for up to 20 seconds for the toggles named by the recipe's read-only
 * `assertToggle` verify steps, and reports the state it saw:
 *   { type: 'passiveCheckResult', serviceId, optOutId, state: 'on'|'off'|'unknown', expected? }
 * `state` is the toggle's raw state; the background compares it with the
 * state the opt-out expects. A toggle that never appears is not reported
 * (visiting a page without the setting says nothing about it). It runs at
 * most once per page load.
 */
(() => {
  'use strict';

  const FLAG = '__notrainPassiveCheck';
  if (globalThis[FLAG]) return;
  globalThis[FLAG] = { startedAt: Date.now() };

  const MAX_WAIT_MS = 20000;

  if (window.top !== window) return; // top frame only

  function runtime() {
    const b = globalThis.browser;
    if (b && b.runtime && typeof b.runtime.sendMessage === 'function') return b.runtime;
    const c = globalThis.chrome;
    if (c && c.runtime && typeof c.runtime.sendMessage === 'function') return c.runtime;
    return null;
  }

  async function send(message) {
    try {
      const rt = runtime();
      if (!rt) return null;
      return (await rt.sendMessage(message)) ?? null;
    } catch {
      return null; // background unavailable or extension reloaded
    }
  }

  /** Accepts both `{ ok, data: { checks } }` and a bare `{ checks }`. */
  function checksFrom(response) {
    if (!response || response.ok === false) return [];
    const data = response.data && typeof response.data === 'object' ? response.data : response;
    return Array.isArray(data.checks) ? data.checks : [];
  }

  /** A NoTrain run in this tab owns the page; stay quiet so results don't race it. */
  function overlayActive() {
    const o = globalThis.NoTrainOverlay;
    try {
      return !!(o && typeof o.isActive === 'function' && o.isActive());
    } catch {
      return false;
    }
  }

  async function runCheck(engine, check, deadline) {
    if (!check || typeof check.serviceId !== 'string' || typeof check.optOutId !== 'string') return;
    const asserts = (Array.isArray(check.verify) ? check.verify : []).filter(
      (s) => s && s.action === 'assertToggle' && s.target && (s.state === 'on' || s.state === 'off'),
    );
    if (!asserts.length) return;

    let mismatch = null;
    let matched = null;
    let unreadable = false;
    for (const step of asserts) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let res;
      try {
        // Prefer a control whose state can be read; waitForTarget only observes the page.
        res = await engine.waitForTarget(step.target, {
          timeoutMs: remaining,
          filter: (el) => engine.readToggleState(el) !== null,
        });
      } catch {
        res = null;
      }
      let el = res && res.element;
      if (!el) {
        // Found but unreadable?
        try {
          el = engine.findTarget(step.target);
        } catch {
          el = null;
        }
        if (el) unreadable = true;
        continue;
      }
      const state = engine.readToggleState(el);
      if (state === null) {
        unreadable = true;
        continue;
      }
      if (state !== step.state) {
        mismatch = { state, expected: step.state };
        break; // one toggle in the wrong state is enough
      }
      matched = { state, expected: step.state };
    }

    const found = mismatch || matched;
    if (!found && !unreadable) return;
    if (overlayActive()) return;
    const result = found || { state: 'unknown' };
    await send({
      type: 'passiveCheckResult',
      serviceId: check.serviceId,
      optOutId: check.optOutId,
      state: result.state,
      ...(result.expected ? { expected: result.expected } : {}),
    });
  }

  async function main() {
    const engine = globalThis.NoTrainEngine;
    if (!engine || typeof engine.waitForTarget !== 'function') return;
    const deadline = globalThis[FLAG].startedAt + MAX_WAIT_MS;
    const checks = checksFrom(await send({ type: 'getPassiveChecks', url: location.href }));
    if (!checks.length) return;
    await Promise.all(checks.map((c) => runCheck(engine, c, deadline).catch(() => {})));
  }

  main().catch(() => {});
})();
