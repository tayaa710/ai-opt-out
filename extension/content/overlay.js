/*
 * NoTrain on-page panel.
 *
 * Classic content script (no imports), injected after content/engine.js.
 * Defines `globalThis.NoTrainOverlay.start(config)` with
 *   { runId, mode: 'auto'|'guided'|'verify',
 *     service: { id, name, company },
 *     optOut: { id, title, steps, effect, automation } }
 * (ARCHITECTURE.md "Opt-out run flow") and reports back with
 * runProgress / runResult / guidedDone messages.
 *
 * The panel lives in a closed shadow root on a custom element appended to
 * <html>: page CSS cannot style it, its CSS cannot leak into the page, and
 * pointer/focus/key events inside it do not reach the page's own handlers
 * (so, for example, it does not dismiss the site's open dialogs).
 * Re-injecting this file is harmless.
 */
(() => {
  'use strict';

  const VERSION = '1.0.0';

  const existing = globalThis.NoTrainOverlay;
  if (existing && existing.VERSION === VERSION) return;
  if (existing && typeof existing.close === 'function') {
    try {
      existing.close();
    } catch {
      /* an older overlay may already be gone */
    }
  }

  const UI_ATTR = 'data-notrain-ui';
  const HOST_TAG = 'notrain-overlay';
  const GUIDE_POLL_MS = 700;
  const MARGIN = 16;

  // ---------------------------------------------------------------------------
  // Messaging

  function runtime() {
    const b = globalThis.browser;
    if (b && b.runtime && typeof b.runtime.sendMessage === 'function') return b.runtime;
    const c = globalThis.chrome;
    if (c && c.runtime && typeof c.runtime.sendMessage === 'function') return c.runtime;
    return null;
  }

  /** Fire-and-forget message to the background; never throws. */
  function send(message) {
    try {
      const rt = runtime();
      if (!rt) return Promise.resolve(null);
      const result = rt.sendMessage(message);
      if (result && typeof result.then === 'function') return result.catch(() => null);
      return Promise.resolve(result ?? null);
    } catch {
      // The extension was reloaded or updated: this page's context is orphaned.
      return Promise.resolve(null);
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (all text goes through textContent; registry strings are never parsed as HTML)

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function')
          el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(value));
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  /** Static, trusted SVG markup only. */
  function icon(name, cls = 'ico') {
    const span = document.createElement('span');
    span.className = cls;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  const SVG = (body, size = 16, view = 24) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${body}</svg>`;

  const ICONS = {
    logo: `<svg width="22" height="22" viewBox="0 0 32 32" focusable="false"><defs><linearGradient id="nt-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#nt-mark)"/><g fill="#fff"><circle cx="16.5" cy="8" r="2.6"/><circle cx="24" cy="8" r="2.6"/><circle cx="24" cy="15.5" r="2.6"/><circle cx="8" cy="16.5" r="2.6"/><circle cx="8" cy="24" r="2.6"/><circle cx="15.5" cy="24" r="2.6"/></g><path d="M7 7 25 25" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/></svg>`,
    close: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
    minimize: SVG('<path d="M6 12h12"/>'),
    expand: SVG('<path d="M6 15l6-6 6 6"/>'),
    check: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 12),
    cross: SVG('<path d="M7 7l10 10M17 7 7 17"/>', 12),
    skip: SVG('<path d="M7 12h10"/>', 12),
    bigCheck: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 20),
    bigAlert: SVG(
      '<path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
      20,
    ),
    bigCross: SVG('<path d="M7 7l10 10M17 7 7 17"/>', 20),
    bigLock: SVG('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 20),
    stop: SVG('<rect x="7" y="7" width="10" height="10" rx="1.5"/>', 20),
    shield: SVG('<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3Z"/>', 12),
  };

  // ---------------------------------------------------------------------------
  // Styles (token values copied from extension/shared/tokens.css)

  const STYLE = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  --nt-primary: #4f46e5; --nt-primary-hover: #4338ca; --nt-on-primary: #ffffff;
  --nt-primary-soft: #eef0ff; --nt-primary-text: #4338ca;
  --nt-good: #059669; --nt-good-text: #047857; --nt-good-soft: #e8f8f1; --nt-good-border: #a7e3c9;
  --nt-warn: #d97706; --nt-warn-text: #b45309; --nt-warn-soft: #fff6e5; --nt-warn-border: #f6d28b;
  --nt-bad: #dc2626; --nt-bad-text: #b91c1c; --nt-bad-soft: #fdeeee; --nt-bad-border: #f5b5b5;
  --nt-surface: #ffffff; --nt-surface-2: #f8f9fc; --nt-surface-3: #eef0f5;
  --nt-text: #0f172a; --nt-text-2: #475569; --nt-text-3: #5f6b7e;
  --nt-border: #e3e7ee; --nt-border-strong: #cbd2dd; --nt-divider: #edf0f4;
  --nt-focus: #4f46e5;
  --nt-shadow: 0 8px 24px rgba(15, 23, 42, 0.14), 0 24px 48px rgba(15, 23, 42, 0.12);
  --nt-ease: cubic-bezier(0.2, 0, 0, 1);
  --nt-font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif;

  position: relative;
  display: flex; flex-direction: column;
  width: min(360px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  margin: 0; padding: 0;
  background: var(--nt-surface); color: var(--nt-text);
  border: 1px solid var(--nt-border); border-radius: 12px;
  box-shadow: var(--nt-shadow);
  font-family: var(--nt-font); font-size: 14px; font-weight: 400; line-height: 1.45;
  letter-spacing: normal; text-align: left; text-transform: none; text-indent: 0;
  white-space: normal; word-spacing: normal; direction: ltr;
  color-scheme: light;
  overflow: hidden;
  animation: nt-in 200ms var(--nt-ease);
  -webkit-font-smoothing: antialiased;
}
@keyframes nt-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes nt-spin { to { transform: rotate(360deg); } }

.bar {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--nt-divider);
  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
}
.bar.dragging { cursor: grabbing; }
.brand { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.brand .ico { display: inline-flex; }
.wordmark { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; color: var(--nt-text); }
.bar-status {
  flex: 1; min-width: 0; margin-left: 4px;
  font-size: 12px; color: var(--nt-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.icon-btn {
  flex: none; width: 32px; height: 32px; margin: 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 8px; background: transparent; color: var(--nt-text-2);
  cursor: pointer; font: inherit;
}
.icon-btn:hover { background: var(--nt-surface-3); color: var(--nt-text); }
.icon-btn .ico { display: inline-flex; }

.body { padding: 16px; overflow-y: auto; overscroll-behavior: contain; }
.panel.collapsed .body { display: none; }
.panel.collapsed .bar { border-bottom: 0; }

.eyebrow { margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--nt-text-2); }
.title { margin: 0 0 12px; font-size: 16px; font-weight: 650; line-height: 1.3; color: var(--nt-text); outline: none; }
.lead { margin: 0 0 12px; font-size: 13px; color: var(--nt-text-2); }
p { margin: 0; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.step { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: var(--nt-text-3); }
.st-icon {
  flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--nt-border-strong); color: #fff;
}
.st-icon .ico { display: inline-flex; }
.step.is-running { color: var(--nt-text); font-weight: 600; }
.step.is-running .st-icon { border-color: var(--nt-primary); border-right-color: transparent; animation: nt-spin 0.8s linear infinite; }
.step.is-done { color: var(--nt-text-2); }
.step.is-done .st-icon { background: var(--nt-good); border-color: var(--nt-good); color: var(--nt-surface); }
.step.is-skipped .st-icon { border-style: dashed; color: var(--nt-text-3); }
.step.is-failed { color: var(--nt-text); }
.step.is-failed .st-icon { background: var(--nt-bad); border-color: var(--nt-bad); color: var(--nt-surface); }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 36px; margin: 0; padding: 0 14px;
  border: 1px solid transparent; border-radius: 8px;
  font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; text-decoration: none;
  cursor: pointer; transition: background-color 120ms var(--nt-ease), border-color 120ms var(--nt-ease);
}
.btn[disabled] { cursor: default; opacity: 0.6; }
.btn-primary { background: var(--nt-primary); color: var(--nt-on-primary); }
.btn-primary:not([disabled]):hover { background: var(--nt-primary-hover); }
.btn-secondary { background: var(--nt-surface); color: var(--nt-text); border-color: var(--nt-border-strong); }
.btn-secondary:not([disabled]):hover { background: var(--nt-surface-3); }
.btn-ghost { background: transparent; color: var(--nt-text-2); }
.btn-ghost:hover { background: var(--nt-surface-3); color: var(--nt-text); }
button:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline: 2px solid var(--nt-focus); outline-offset: 2px; }
.title:focus-visible { outline: none; }

.result { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 4px; }
.result .title { margin-bottom: 4px; }
.result-icon {
  flex: none; width: 36px; height: 36px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
}
.result-icon .ico { display: inline-flex; }
.tone-good .result-icon { background: var(--nt-good-soft); color: var(--nt-good-text); }
.tone-warn .result-icon { background: var(--nt-warn-soft); color: var(--nt-warn-text); }
.tone-bad .result-icon { background: var(--nt-bad-soft); color: var(--nt-bad-text); }
.tone-neutral .result-icon { background: var(--nt-surface-3); color: var(--nt-text-2); }

.note {
  margin-top: 14px; padding: 10px 12px;
  background: var(--nt-surface-2); border: 1px solid var(--nt-divider); border-radius: 10px;
  font-size: 13px; color: var(--nt-text-2);
}
.note-title { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 700; color: var(--nt-text); }
.notice {
  margin: 0 0 12px; padding: 10px 12px; border-radius: 10px;
  background: var(--nt-warn-soft); border: 1px solid var(--nt-warn-border);
  font-size: 13px; color: var(--nt-text);
}
.hint {
  display: flex; gap: 8px; align-items: center; margin-top: 12px; padding: 8px 10px; border-radius: 8px;
  background: var(--nt-good-soft); border: 1px solid var(--nt-good-border);
  font-size: 13px; font-weight: 600; color: var(--nt-good-text);
}
.hint .ico { display: inline-flex; }

.guide { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.guide-btn {
  display: flex; gap: 10px; align-items: flex-start; width: 100%; margin: 0; padding: 8px;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  font-family: inherit; font-size: 13px; font-weight: 400; line-height: 1.45; text-align: left;
  color: var(--nt-text-2); cursor: pointer;
}
.guide-btn:hover { background: var(--nt-surface-2); }
.guide-btn[aria-current='step'] { background: var(--nt-primary-soft); color: var(--nt-text); }
.num {
  flex: none; width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--nt-surface-3); color: var(--nt-text-2); font-size: 12px; font-weight: 700;
}
.guide-btn[aria-current='step'] .num { background: var(--nt-primary); color: var(--nt-on-primary); }
.locate { display: block; margin-top: 2px; font-size: 12px; font-weight: 600; color: var(--nt-primary-text); }

.fineprint { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 14px; font-size: 12px; color: var(--nt-text-3); }
.fineprint .ico { display: inline-flex; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  background: var(--nt-warn-soft); color: var(--nt-warn-text);
  font-size: 11px; font-weight: 700;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@media (prefers-color-scheme: dark) {
  .panel {
    --nt-primary: #818cf8; --nt-primary-hover: #a5b4fc; --nt-on-primary: #11132b;
    --nt-primary-soft: #23264a; --nt-primary-text: #a5b4fc;
    --nt-good: #34d399; --nt-good-text: #6ee7b7; --nt-good-soft: #10302a; --nt-good-border: #1d5b48;
    --nt-warn: #fbbf24; --nt-warn-text: #fcd34d; --nt-warn-soft: #362a10; --nt-warn-border: #6b5217;
    --nt-bad: #f87171; --nt-bad-text: #fca5a5; --nt-bad-soft: #3a1c20; --nt-bad-border: #6f2d33;
    --nt-surface: #151822; --nt-surface-2: #1a1e2a; --nt-surface-3: #222736;
    --nt-text: #eceef5; --nt-text-2: #b3bacb; --nt-text-3: #9ba3b6;
    --nt-border: #2a2f3e; --nt-border-strong: #3b4254; --nt-divider: #232837;
    --nt-focus: #a5b4fc;
    --nt-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 24px 48px rgba(0, 0, 0, 0.4);
    color-scheme: dark;
  }
}
@media (prefers-reduced-motion: reduce) {
  .panel, .panel *, .panel *::before, .panel *::after { animation: none !important; transition: none !important; }
  .step.is-running .st-icon { border-right-color: var(--nt-primary); }
}
@media (forced-colors: active) {
  .panel { border: 1px solid CanvasText; }
  .btn { border: 1px solid ButtonText; }
}
`;

  const HOST_CSS = [
    'all: initial',
    'position: fixed',
    `right: ${MARGIN}px`,
    `bottom: ${MARGIN}px`,
    'left: auto',
    'top: auto',
    'z-index: 2147483647',
    'display: block',
    'width: auto',
    'height: auto',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'background: transparent',
    'pointer-events: auto',
    'visibility: visible',
    'opacity: 1',
    'transform: none',
    'filter: none',
    'contain: layout style',
  ];

  // ---------------------------------------------------------------------------
  // Text helpers

  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim();

  function engine() {
    const e = globalThis.NoTrainEngine;
    return e && typeof e.runSteps === 'function' ? e : null;
  }

  function norm(s) {
    const e = engine();
    if (e) return e.normalizeText(s);
    return clean(s).toLowerCase();
  }

  function firstText(target) {
    if (!target || typeof target !== 'object') return '';
    const t = Array.isArray(target.text) ? target.text[0] : target.text;
    return t ? clean(t) : '';
  }

  function describe(step) {
    const e = engine();
    if (e) return e.describeStep(step);
    return clean(step && step.description) || 'Working';
  }

  /** Verify steps: automation.verify, else the steps up to the last setToggle, read-only. */
  function verifyStepsOf(automation) {
    if (!automation) return [];
    if (Array.isArray(automation.verify) && automation.verify.length) return automation.verify;
    const steps = Array.isArray(automation.steps) ? automation.steps : [];
    let last = -1;
    steps.forEach((s, i) => {
      if (s && s.action === 'setToggle') last = i;
    });
    if (last < 0) return [];
    return steps
      .slice(0, last + 1)
      .map((s) => (s.action === 'setToggle' ? { ...s, action: 'assertToggle', description: undefined } : s));
  }

  // ---------------------------------------------------------------------------
  // Config

  function normalizeConfig(config) {
    if (!config || typeof config !== 'object')
      throw new TypeError('NoTrainOverlay.start needs a config object');
    const service = config.service && typeof config.service === 'object' ? config.service : {};
    const optOut = config.optOut && typeof config.optOut === 'object' ? config.optOut : {};
    const a = optOut.automation;
    const automation =
      a && typeof a === 'object' && Array.isArray(a.steps) && a.steps.length
        ? {
            confidence: a.confidence,
            steps: a.steps,
            verify: Array.isArray(a.verify) ? a.verify : [],
            loginIndicators: Array.isArray(a.loginIndicators) ? a.loginIndicators : [],
          }
        : null;
    return {
      runId: config.runId == null ? null : String(config.runId),
      mode: ['auto', 'guided', 'verify'].includes(config.mode) ? config.mode : 'guided',
      service: {
        id: clean(service.id),
        name: clean(service.name) || 'this site',
        company: clean(service.company),
      },
      optOut: {
        id: clean(optOut.id),
        title: clean(optOut.title) || 'Opt out of AI training',
        steps: Array.isArray(optOut.steps) ? optOut.steps.map(clean).filter(Boolean) : [],
        effect: clean(optOut.effect),
        automation,
      },
    };
  }

  /** The setting the recipe switches, e.g. { label: 'Improve the model for everyone', state: 'off' }. */
  function settingOf(automation) {
    const steps = automation ? automation.steps : [];
    for (const s of steps) {
      if (s && s.action === 'setToggle' && firstText(s.target))
        return { label: firstText(s.target), state: s.state };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Panel

  let current = null;

  class Panel {
    constructor(config) {
      this.config = config;
      this.setting = settingOf(config.optOut.automation);
      this.destroyed = false;
      this.running = null; // { controller, mode }
      this.view = null;
      this.collapsed = false;
      this.guide = null;
      this.cleanups = [];
    }

    // --- lifecycle -----------------------------------------------------------

    mount() {
      const host = document.createElement(HOST_TAG);
      host.setAttribute(UI_ATTR, 'overlay');
      host.style.cssText = HOST_CSS.map((d) => `${d} !important`).join(';');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLE;

      this.statusEl = h('span', { class: 'bar-status', 'aria-hidden': 'true' });
      this.collapseBtn = h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-expanded': 'true',
          'aria-controls': 'nt-body',
          'aria-label': 'Minimise NoTrain panel',
          title: 'Minimise',
          onclick: () => this.toggleCollapsed(),
        },
        icon('minimize'),
      );
      const closeBtn = h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': 'Close NoTrain panel',
          title: 'Close',
          onclick: () => this.close(),
        },
        icon('close'),
      );
      this.bar = h(
        'div',
        { class: 'bar' },
        h('span', { class: 'brand' }, icon('logo'), h('span', { class: 'wordmark', text: 'NoTrain' })),
        this.statusEl,
        this.collapseBtn,
        closeBtn,
      );
      this.body = h('div', { class: 'body', id: 'nt-body' });
      this.live = h('div', {
        class: 'sr-only',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      });
      this.panel = h(
        'div',
        {
          class: 'panel',
          role: 'dialog',
          'aria-modal': 'false',
          'aria-labelledby': 'nt-title',
          'aria-describedby': 'nt-desc',
        },
        this.bar,
        this.body,
        this.live,
      );
      shadow.append(style, this.panel);
      this.host = host;
      this.shadow = shadow;
      (document.documentElement || document.body).appendChild(host);

      this.isolateEvents();
      this.enableDrag();
      this.keepAttached();
      const onResize = () => this.clampPosition();
      window.addEventListener('resize', onResize);
      this.cleanups.push(() => window.removeEventListener('resize', onResize));
      const dodge = setInterval(() => this.avoidHighlight(), 300);
      this.cleanups.push(() => clearInterval(dodge));
    }

    /** Places the panel in a corner: 'br' | 'bl' | 'tr' | 'tl'. */
    placeCorner(corner) {
      this.corner = corner;
      const s = this.host.style;
      const set = (prop, value) => s.setProperty(prop, value, 'important');
      set('left', corner[1] === 'l' ? `${MARGIN}px` : 'auto');
      set('right', corner[1] === 'r' ? `${MARGIN}px` : 'auto');
      set('top', corner[0] === 't' ? `${MARGIN}px` : 'auto');
      set('bottom', corner[0] === 'b' ? `${MARGIN}px` : 'auto');
    }

    /**
     * Never cover the control NoTrain is pointing at: if the highlighted
     * element is under the panel, move to the first free corner (unless the
     * person has dragged the panel somewhere themselves).
     */
    avoidHighlight() {
      if (this.destroyed || this.pos) return;
      const e = engine();
      const el = e && typeof e.highlightedElement === 'function' ? e.highlightedElement() : null;
      if (!el) return;
      const t = el.getBoundingClientRect();
      const p = this.host.getBoundingClientRect();
      const gap = 8;
      const hits = (x, y) =>
        !(
          t.right < x - gap ||
          t.left > x + p.width + gap ||
          t.bottom < y - gap ||
          t.top > y + p.height + gap
        );
      const at = {
        br: [innerWidth - MARGIN - p.width, innerHeight - MARGIN - p.height],
        bl: [MARGIN, innerHeight - MARGIN - p.height],
        tr: [innerWidth - MARGIN - p.width, MARGIN],
        tl: [MARGIN, MARGIN],
      };
      const now = this.corner || 'br';
      if (!hits(...at[now])) return;
      const free = ['br', 'bl', 'tr', 'tl'].find((c) => c !== now && !hits(...at[c]));
      if (free) this.placeCorner(free);
    }

    /** Events inside the panel stay inside: the page never sees clicks, focus or keys meant for NoTrain. */
    isolateEvents() {
      const stop = (e) => e.stopPropagation();
      for (const type of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'dblclick',
        'contextmenu',
        'auxclick',
        'focusin',
        'focusout',
        'touchstart',
        'touchend',
        'wheel',
        'input',
        'change',
      ]) {
        this.host.addEventListener(type, stop);
      }
      // Key events are stopped before the page's own (document-level) capture
      // listeners run; default actions (Tab, Enter/Space on buttons) still happen.
      const onKey = (e) => {
        if (e.target !== this.host) return;
        if (e.type === 'keydown' && e.key === 'Escape' && !e.isComposing) {
          e.preventDefault();
          this.close();
        }
        e.stopPropagation();
      };
      for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, onKey, true);
      this.cleanups.push(() => {
        for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, onKey, true);
      });
    }

    enableDrag() {
      let drag = null;
      const onDown = (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const rect = this.host.getBoundingClientRect();
        drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        try {
          this.bar.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        this.bar.classList.add('dragging');
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        this.moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
      };
      const onUp = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        this.bar.classList.remove('dragging');
      };
      this.bar.addEventListener('pointerdown', onDown);
      this.bar.addEventListener('pointermove', onMove);
      this.bar.addEventListener('pointerup', onUp);
      this.bar.addEventListener('pointercancel', onUp);
    }

    moveTo(x, y) {
      const rect = this.host.getBoundingClientRect();
      const maxX = Math.max(0, window.innerWidth - rect.width);
      const maxY = Math.max(0, window.innerHeight - rect.height);
      this.pos = { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
      const s = this.host.style;
      s.setProperty('left', `${Math.round(this.pos.x)}px`, 'important');
      s.setProperty('top', `${Math.round(this.pos.y)}px`, 'important');
      s.setProperty('right', 'auto', 'important');
      s.setProperty('bottom', 'auto', 'important');
    }

    clampPosition() {
      if (this.pos) this.moveTo(this.pos.x, this.pos.y);
    }

    /** Single-page apps sometimes wipe foreign nodes; put the panel back if that happens. */
    keepAttached() {
      const root = document.documentElement;
      if (!root) return;
      const observer = new MutationObserver(() => {
        if (!this.destroyed && !this.host.isConnected) root.appendChild(this.host);
      });
      observer.observe(root, { childList: true });
      this.cleanups.push(() => observer.disconnect());
    }

    close() {
      if (this.destroyed) return;
      if (this.running) this.running.controller.abort();
      this.destroy();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stopGuide();
      const e = engine();
      if (e) e.clearHighlight();
      for (const fn of this.cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      if (this.host) this.host.remove();
      if (current === this) current = null;
    }

    // --- shared view helpers ---------------------------------------------------

    render(view, nodes, { status = '', announce = '', focus = null } = {}) {
      if (this.destroyed) return;
      if (view !== 'guided') this.stopGuide();
      this.view = view;
      this.panel.dataset.view = view;
      this.body.replaceChildren(...nodes.filter(Boolean));
      this.statusEl.textContent = status;
      if (announce) this.announce(announce);
      if (focus) this.focus(focus);
    }

    announce(text) {
      // Clear first so repeating the same text is announced again; only the
      // latest message is spoken when several arrive at once.
      clearTimeout(this.announceTimer);
      this.live.textContent = '';
      this.announceTimer = setTimeout(() => {
        if (!this.destroyed) this.live.textContent = text;
      }, 50);
    }

    focus(el) {
      if (!el || this.collapsed) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }

    toggleCollapsed(force) {
      this.collapsed = typeof force === 'boolean' ? force : !this.collapsed;
      this.panel.classList.toggle('collapsed', this.collapsed);
      this.collapseBtn.setAttribute('aria-expanded', String(!this.collapsed));
      this.collapseBtn.setAttribute(
        'aria-label',
        this.collapsed ? 'Expand NoTrain panel' : 'Minimise NoTrain panel',
      );
      this.collapseBtn.title = this.collapsed ? 'Expand' : 'Minimise';
      this.collapseBtn.replaceChildren(icon(this.collapsed ? 'expand' : 'minimize'));
      this.statusEl.setAttribute('aria-hidden', String(!this.collapsed));
      this.clampPosition();
    }

    eyebrow(suffix) {
      const { name, company } = this.config.service;
      const who = company && company.toLowerCase() !== name.toLowerCase() ? `${name} · ${company}` : name;
      return h('p', { class: 'eyebrow', text: suffix ? `${who} · ${suffix}` : who });
    }

    title(text) {
      return h('h2', { class: 'title', id: 'nt-title', tabindex: '-1', text });
    }

    effectNote() {
      const { effect } = this.config.optOut;
      if (!effect) return null;
      return h(
        'div',
        { class: 'note' },
        h('span', { class: 'note-title', text: 'What this does' }),
        h('p', { text: effect }),
      );
    }

    button(label, kind, onclick, extra = {}) {
      return h('button', { type: 'button', class: `btn btn-${kind}`, onclick, ...extra }, label);
    }

    resultBlock(tone, iconName, titleText, text) {
      return h(
        'div',
        { class: `result tone-${tone}` },
        h('span', { class: 'result-icon' }, icon(iconName)),
        h('div', null, this.title(titleText), text ? h('p', { class: 'lead', id: 'nt-desc', text }) : null),
      );
    }

    settingName() {
      return this.setting ? `“${this.setting.label}”` : null;
    }

    // --- report ----------------------------------------------------------------

    report(outcome, message) {
      const { runId, mode, service, optOut } = this.config;
      return send({
        type: 'runResult',
        runId,
        serviceId: service.id,
        optOutId: optOut.id,
        mode,
        outcome,
        ...(message ? { message: String(message).slice(0, 500) } : {}),
      });
    }

    // --- flows -----------------------------------------------------------------

    begin() {
      const { mode, optOut } = this.config;
      if (mode === 'guided') {
        this.showGuided();
      } else if (!optOut.automation || !engine()) {
        this.showGuided({
          notice: 'NoTrain can’t do this one automatically. Follow the steps below instead.',
        });
      } else if (mode === 'verify') {
        this.runVerify();
      } else {
        this.runAuto();
      }
    }

    async execute(kind, steps) {
      const e = engine();
      const total = steps.length;
      const controller = new AbortController();
      this.running = { controller, kind };
      const statuses = steps.map(() => 'pending');
      const items = steps.map((step) => {
        const text = h('span', { text: describe(step) });
        const state = h('span', { class: 'sr-only', text: ' (not started)' });
        const li = h(
          'li',
          { class: 'step is-pending' },
          h('span', { class: 'st-icon' }),
          h('span', null, text, state),
        );
        return { li, state };
      });
      const stopBtn = this.button('Stop', 'secondary', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        controller.abort();
      });
      const setting = this.settingName();
      let heading;
      if (kind === 'verify')
        heading = setting
          ? `Checking that ${setting} is still ${this.setting.state}`
          : 'Checking your setting';
      else if (setting) heading = `NoTrain is turning ${this.setting.state} ${setting} for you`;
      else heading = `NoTrain is working on: ${this.config.optOut.title}`;
      const confidence = this.config.optOut.automation.confidence;
      this.render(
        'running',
        [
          this.eyebrow(),
          this.title(heading),
          h(
            'ol',
            { class: 'steps', 'aria-label': 'Progress' },
            items.map((i) => i.li),
          ),
          h('div', { class: 'actions' }, stopBtn),
          h(
            'p',
            { class: 'fineprint', id: 'nt-desc' },
            icon('shield'),
            kind === 'verify'
              ? 'Read-only check. Nothing is changed.'
              : 'Runs only in this tab. Nothing leaves your device.',
            confidence === 'experimental' ? h('span', { class: 'badge', text: 'Experimental' }) : null,
          ),
        ],
        { status: 'Starting…', announce: heading },
      );

      const onProgress = (p) => {
        if (this.destroyed) return;
        const item = items[p.stepIndex];
        if (!item) return;
        const status = p.status === 'pending' ? 'done' : p.status;
        statuses[p.stepIndex] = status;
        item.li.className = `step is-${status}`;
        const iconName = { done: 'check', failed: 'cross', skipped: 'skip' }[status];
        item.li.firstChild.replaceChildren(iconName ? icon(iconName) : '');
        item.state.textContent =
          {
            running: ' (in progress)',
            done: ' (done)',
            skipped: ' (not needed)',
            failed: ' (failed)',
          }[status] || '';
        if (status === 'running') {
          this.statusEl.textContent = `Step ${p.stepIndex + 1} of ${total}`;
          this.announce(`Step ${p.stepIndex + 1} of ${total}: ${p.description}`);
          send({
            type: 'runProgress',
            runId: this.config.runId,
            stepIndex: p.stepIndex,
            total,
            description: p.description,
          });
        }
      };

      let result;
      try {
        result = await e.runSteps(steps, {
          signal: controller.signal,
          onProgress,
          mode: kind === 'verify' ? 'verify' : 'auto',
          loginIndicators: this.config.optOut.automation.loginIndicators,
          highlight: kind !== 'verify',
        });
      } catch (err) {
        result = { outcome: 'failed', message: `Unexpected error: ${(err && err.message) || err}` };
      }
      if (this.running && this.running.controller === controller) this.running = null;
      return result;
    }

    async runAuto() {
      const result = await this.execute('auto', this.config.optOut.automation.steps);
      this.report(result.outcome, result.message);
      if (this.destroyed) return;
      const setting = this.settingName();
      const name = this.config.service.name;
      switch (result.outcome) {
        case 'success':
          this.showDone(
            'good',
            'bigCheck',
            setting ? `${setting} is now ${this.setting.state}` : 'All done',
            setting
              ? `NoTrain changed the setting on ${name} and checked that it stuck.`
              : `NoTrain completed every step on ${name}.`,
            'Done',
          );
          break;
        case 'already':
          this.showDone(
            'good',
            'bigCheck',
            setting ? `${setting} was already ${this.setting.state}` : 'Already done',
            `Nothing needed changing on ${name}. NoTrain has recorded it.`,
            'Already done',
          );
          break;
        case 'needs_login':
          this.showLogin(() => this.runAuto());
          break;
        case 'cancelled':
          this.showStopped();
          break;
        default:
          this.showGuided({
            notice: `NoTrain couldn’t finish this automatically. ${clean(result.message)} Follow the steps below instead.`,
          });
      }
    }

    async runVerify() {
      const steps = verifyStepsOf(this.config.optOut.automation);
      if (!steps.length) {
        this.report('failed', 'This opt-out has no verification steps.');
        this.showGuided({
          notice: 'NoTrain can’t check this setting automatically. Here is how to check it yourself.',
        });
        return;
      }
      const result = await this.execute('verify', steps);
      this.report(result.outcome, result.message);
      if (this.destroyed) return;
      const setting = this.settingName();
      const name = this.config.service.name;
      switch (result.outcome) {
        case 'success':
        case 'already':
          this.showDone(
            'good',
            'bigCheck',
            setting ? `${setting} is still ${this.setting.state}` : 'Still opted out',
            'Nothing has changed since you opted out.',
            'Still opted out',
          );
          break;
        case 'mismatch':
          this.showMismatch();
          break;
        case 'needs_login':
          this.showLogin(() => this.runVerify());
          break;
        case 'cancelled':
          this.showStopped();
          break;
        default:
          this.showGuided({
            notice: `NoTrain couldn’t check this automatically. ${clean(result.message)} Here is how to check it on ${name} yourself.`,
          });
      }
    }

    // --- result views ------------------------------------------------------------

    showDone(tone, iconName, titleText, text, status) {
      const close = this.button('Close', 'primary', () => this.close());
      this.render(
        'done',
        [
          this.resultBlock(tone, iconName, titleText, text),
          this.effectNote(),
          h('div', { class: 'actions' }, close),
        ],
        { status, announce: `${titleText}. ${text}`, focus: close },
      );
    }

    showLogin(retry) {
      const name = this.config.service.name;
      const again = this.button('Try again', 'primary', () => retry());
      const text =
        'Sign in on this page, then press Try again. If signing in takes you to another page, start again from NoTrain.';
      this.render(
        'login',
        [
          this.resultBlock('warn', 'bigLock', `Sign in to ${name} first`, text),
          h(
            'div',
            { class: 'actions' },
            again,
            this.button('Show me the steps', 'secondary', () => this.showGuided()),
            this.button('Close', 'ghost', () => this.close()),
          ),
        ],
        { status: 'Sign in first', announce: `Sign in to ${name} first. ${text}`, focus: again },
      );
    }

    showStopped() {
      const text = 'Anything already changed stays changed; nothing else on this page will be touched.';
      const steps = this.button('Show me the steps', 'secondary', () => this.showGuided());
      this.render(
        'stopped',
        [
          this.resultBlock('neutral', 'stop', 'Stopped', text),
          h(
            'div',
            { class: 'actions' },
            steps,
            this.button('Close', 'ghost', () => this.close()),
          ),
        ],
        { status: 'Stopped', announce: `Stopped. ${text}`, focus: steps },
      );
    }

    showMismatch() {
      const setting = this.settingName();
      const name = this.config.service.name;
      const titleText = setting
        ? `${setting} has been switched back ${this.setting.state === 'off' ? 'on' : 'off'}`
        : 'Your setting changed';
      const text = `${name} may be using your data for AI training again.`;
      const canFix = !!(this.config.optOut.automation && this.config.optOut.automation.steps.length);
      const primary = canFix
        ? this.button(setting ? `Turn it ${this.setting.state} again` : 'Opt out again', 'primary', () =>
            this.runAuto(),
          )
        : this.button('Show me the steps', 'primary', () => this.showGuided());
      this.render(
        'mismatch',
        [
          this.resultBlock('bad', 'bigAlert', titleText, text),
          h(
            'div',
            { class: 'actions' },
            primary,
            canFix ? this.button('Show me the steps', 'secondary', () => this.showGuided()) : null,
            this.button('Close', 'ghost', () => this.close()),
          ),
        ],
        { status: 'Switched back', announce: `${titleText}. ${text}`, focus: primary },
      );
    }

    // --- guided mode -------------------------------------------------------------

    showGuided({ notice = '' } = {}) {
      this.stopGuide();
      const { optOut } = this.config;
      const steps = optOut.steps.length
        ? optOut.steps
        : [`Find the setting on this page and switch it ${this.setting ? this.setting.state : 'off'}.`];
      const targets = this.guideTargets(steps);
      const canPoint = !!engine() && targets.length > 0;
      const buttons = steps.map((text, i) => {
        const locate = h('span', { class: 'locate', hidden: true, text: 'Highlighted on the page' });
        const btn = h(
          'button',
          { type: 'button', class: 'guide-btn', onclick: () => this.selectStep(i, true) },
          h('span', { class: 'num', 'aria-hidden': 'true', text: String(i + 1) }),
          h('span', null, h('span', { class: 'sr-only', text: `Step ${i + 1}: ` }), text, locate),
        );
        return { btn, locate };
      });
      const hint = h('p', { class: 'hint', hidden: true }, icon('check'), h('span'));
      const doneBtn = this.button('I’ve done it', 'primary', () => this.guidedDone());
      const titleEl = this.title(optOut.title);
      this.render(
        'guided',
        [
          this.eyebrow('Step by step'),
          titleEl,
          notice ? h('p', { class: 'notice', role: 'note', text: notice }) : null,
          h(
            'p',
            { class: 'lead', id: 'nt-desc' },
            canPoint
              ? 'Follow these steps on this page. NoTrain highlights the right control when it can find it.'
              : 'Follow these steps on this page.',
          ),
          h(
            'ol',
            { class: 'guide', 'aria-label': 'Steps' },
            buttons.map((b) => h('li', null, b.btn)),
          ),
          hint,
          this.effectNote(),
          h(
            'div',
            { class: 'actions' },
            doneBtn,
            this.button('Close', 'ghost', () => this.close()),
          ),
        ],
        {
          status: 'Step by step',
          announce: notice ? `${notice}` : `${optOut.title}. ${steps.length} steps.`,
          focus: notice ? titleEl : doneBtn,
        },
      );
      this.guide = {
        steps,
        buttons,
        targets,
        hint,
        current: -1,
        manual: false,
        lastActive: null,
        lastAutoKey: null,
        autoKeyAtManual: null,
        timer: null,
      };
      this.selectStep(0, false);
      if (canPoint) {
        const tick = () => this.guideTick();
        this.guide.timer = setInterval(tick, GUIDE_POLL_MS);
        tick();
      }
    }

    /** Automation targets a person would press, mapped to the human steps that mention them. */
    guideTargets(steps) {
      const automation = this.config.optOut.automation;
      if (!automation) return [];
      const normSteps = steps.map(norm);
      const out = [];
      automation.steps.forEach((s, i) => {
        if (!s || !s.target || !['click', 'setToggle'].includes(s.action)) return;
        const texts = (Array.isArray(s.target.text) ? s.target.text : []).map(norm).filter(Boolean);
        let stepIndex = -1;
        for (let k = normSteps.length - 1; k >= 0 && stepIndex < 0; k -= 1) {
          if (texts.some((t) => normSteps[k].includes(t))) stepIndex = k;
        }
        out.push({
          index: i,
          action: s.action,
          target: s.target,
          state: s.state,
          stepIndex,
          label: firstText(s.target),
        });
      });
      return out;
    }

    selectStep(i, manual) {
      const g = this.guide;
      if (!g || i < 0 || i >= g.buttons.length) return;
      g.current = i;
      if (manual) {
        g.manual = true;
        g.autoKeyAtManual = g.lastAutoKey;
      }
      g.buttons.forEach((b, k) => {
        if (k === i) b.btn.setAttribute('aria-current', 'step');
        else b.btn.removeAttribute('aria-current');
      });
      this.statusEl.textContent = `Step ${i + 1} of ${g.buttons.length}`;
      if (manual) this.guideTick(true);
    }

    /**
     * Read-only poll: finds where the person is (the latest recipe control that
     * is on screen and not yet done), moves the current step there and rings
     * that control. A step picked by hand stays current until the page moves on.
     */
    guideTick(fromUser = false) {
      const g = this.guide;
      const e = engine();
      if (!g || !e || this.destroyed) return;
      if (document.hidden && !fromUser) return;
      const find = (t) => {
        try {
          return e.findTarget(t.target);
        } catch {
          return null;
        }
      };
      let auto = null;
      let satisfied = null;
      for (let k = g.targets.length - 1; k >= 0; k -= 1) {
        const t = g.targets[k];
        const el = find(t);
        if (!el) continue;
        if (t.action === 'setToggle' && e.readToggleState(el) === t.state) {
          satisfied = satisfied || t;
          continue;
        }
        auto = { t, el };
        break;
      }
      const autoKey = auto ? auto.t.index : null;
      g.lastAutoKey = autoKey;
      if (g.manual && !fromUser && autoKey !== g.autoKeyAtManual) g.manual = false;

      let active = null;
      if (g.manual) {
        const mine = g.targets.filter((t) => t.stepIndex === g.current);
        for (let k = mine.length - 1; k >= 0 && !active; k -= 1) {
          const el = find(mine[k]);
          if (el) active = { t: mine[k], el };
        }
      } else {
        active = auto;
        if (active && active.t.stepIndex >= 0 && active.t.stepIndex !== g.current)
          this.selectStep(active.t.stepIndex, false);
      }

      const key = active ? `${g.manual ? 'm' : 'a'}${active.t.index}` : null;
      if (key !== g.lastActive || fromUser) {
        g.lastActive = key;
        if (active) {
          const label = active.t.stepIndex >= 0 ? `Step ${active.t.stepIndex + 1}` : 'Here';
          e.highlight(active.el, { label, scroll: true });
        } else {
          e.clearHighlight();
        }
        g.buttons.forEach((b, k) => {
          b.locate.hidden = !(active && active.t.stepIndex === k);
        });
      }

      const hintText = satisfied && !auto ? `Looks like “${satisfied.label}” is ${satisfied.state} now.` : '';
      const span = g.hint.lastChild;
      if (span.textContent !== hintText) {
        span.textContent = hintText;
        g.hint.hidden = !hintText;
        if (hintText) this.announce(hintText);
      }
    }

    stopGuide() {
      if (!this.guide) return;
      clearInterval(this.guide.timer);
      this.guide = null;
      const e = engine();
      if (e) e.clearHighlight();
    }

    guidedDone() {
      const { runId, service, optOut } = this.config;
      send({ type: 'guidedDone', runId, serviceId: service.id, optOutId: optOut.id });
      this.showDone(
        'good',
        'bigCheck',
        'Marked as done',
        `Thanks. NoTrain will remind you to check ${service.name} again from time to time.`,
        'Done',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API

  /**
   * Shows the panel and starts the run. Returns synchronously (never a
   * promise, so chrome.scripting.executeScript does not wait for the run).
   * A second call replaces the current panel (and stops its run).
   * @returns {{ started: boolean, runId: string|null, mode: string }}
   */
  function start(config) {
    const cfg = normalizeConfig(config);
    if (current) current.close();
    const panel = new Panel(cfg);
    current = panel;
    panel.mount();
    panel.begin();
    return { started: true, runId: cfg.runId, mode: cfg.mode };
  }

  function close() {
    if (current) current.close();
  }

  /** True while a panel is open (the passive check stays quiet then). */
  function isActive() {
    return !!current && !current.destroyed;
  }

  const api = { VERSION, start, close, isActive };
  if (globalThis.__NOTRAIN_TEST__ === true) {
    // Test hook (Playwright cannot see into closed shadow roots). Content scripts
    // run in an isolated world, so pages could not reach this even if it were set.
    api._shadow = () => (current ? current.shadow : null);
  }
  globalThis.NoTrainOverlay = Object.freeze(api);
})();
