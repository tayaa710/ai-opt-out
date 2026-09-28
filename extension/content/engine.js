/*
 * NoTrain in-page automation engine.
 *
 * Classic content script (no imports). Defines `globalThis.NoTrainEngine`,
 * which interprets the registry's declarative automation DSL (see
 * ARCHITECTURE.md "Automation DSL" and registry/schema/service.schema.json
 * `$defs.automation|target|step`). Re-injecting this file is harmless: an
 * engine of the same version is kept as is.
 *
 * Safety rules this file enforces:
 *  - It only ever clicks an element matched by a recipe target (or, for
 *    setToggle, the matched control's own <label>). Nothing else.
 *  - It never types text, never presses keys and never submits a form except
 *    through an explicit recipe `click` on a submit button.
 *  - Hidden elements are never matched.
 *  - `click` refuses to press a switch/checkbox: toggles are only changed by
 *    `setToggle`, which reads the state first, so a re-run cannot flip a
 *    setting back on.
 *  - Read-only APIs (findTarget, findAll, readToggleState, checkLogin,
 *    waitForTarget) never modify the page.
 */
(() => {
  'use strict';

  const VERSION = '1.0.0';

  const existing = globalThis.NoTrainEngine;
  if (existing && existing.VERSION === VERSION) return;
  if (existing && typeof existing.clearHighlight === 'function') {
    try {
      existing.clearHighlight();
    } catch {
      /* an older engine may already be half torn down */
    }
  }

  // Duplicated from extension/lib/constants.js (content scripts cannot import).
  const OUTCOMES = Object.freeze({
    success: 'success',
    already: 'already',
    notFound: 'not_found',
    needsLogin: 'needs_login',
    failed: 'failed',
    cancelled: 'cancelled',
    mismatch: 'mismatch',
  });

  const DEFAULTS = Object.freeze({
    waitForTimeoutMs: 10000,
    clickTimeoutMs: 5000,
    optionalClickTimeoutMs: 2500,
    toggleTimeoutMs: 5000,
    assertTimeoutMs: 5000,
    pollMs: 250,
    minCheckGapMs: 80,
    loginGraceMs: 1500,
    settleQuietMs: 150,
    settleMaxMs: 1500,
    stableMs: 400,
    rowLevels: 5,
    rowMaxChars: 300,
  });

  /** Attribute on NoTrain's own page elements (overlay, highlight); never matched. */
  const UI_ATTR = 'data-notrain-ui';

  const ROLES = new Set([
    'switch',
    'checkbox',
    'button',
    'link',
    'tab',
    'menuitem',
    'radio',
    'option',
    'dialog',
    'textbox',
    'combobox',
  ]);

  /** Every ARIA role we recognise when it is set explicitly. */
  const KNOWN_ARIA_ROLES = new Set([
    ...ROLES,
    'alertdialog',
    'searchbox',
    'listbox',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'gridcell',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'heading',
    'img',
    'group',
    'region',
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'form',
    'search',
    'list',
    'listitem',
    'menu',
    'menubar',
    'tablist',
    'tabpanel',
    'toolbar',
    'tooltip',
    'status',
    'alert',
    'log',
    'progressbar',
    'slider',
    'spinbutton',
    'scrollbar',
    'separator',
    'article',
    'document',
    'application',
    'presentation',
    'none',
    'generic',
    'paragraph',
    'radiogroup',
    'tree',
    'grid',
    'table',
    'feed',
    'figure',
    'math',
    'note',
    'term',
    'definition',
    'timer',
    'marquee',
  ]);

  /**
   * Which computed roles satisfy a requested role. The strict set is tried
   * first; the lenient set only when nothing strict matches (e.g. a recipe
   * says "button" but the site renders a tab or a link). Stateful controls are
   * never in a stateless role's set, so a "button" target can never resolve
   * to a switch.
   */
  const ROLE_SETS = Object.freeze({
    switch: { strict: ['switch'], lenient: ['checkbox'] },
    checkbox: { strict: ['checkbox'], lenient: ['switch'] },
    button: { strict: ['button'], lenient: ['link', 'tab', 'menuitem'] },
    link: { strict: ['link'], lenient: ['button', 'tab', 'menuitem'] },
    tab: { strict: ['tab'], lenient: ['button', 'link', 'menuitem'] },
    menuitem: { strict: ['menuitem'], lenient: ['button', 'link', 'option'] },
    radio: { strict: ['radio'], lenient: ['menuitemradio', 'option'] },
    option: { strict: ['option'], lenient: ['menuitemradio', 'radio'] },
    dialog: { strict: ['dialog', 'alertdialog'], lenient: [] },
    textbox: { strict: ['textbox', 'searchbox'], lenient: [] },
    combobox: { strict: ['combobox', 'listbox'], lenient: [] },
  });

  /** Roles whose accessible name comes from their content. */
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'switch',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'treeitem',
    'heading',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'row',
    'tooltip',
  ]);

  const TOGGLE_ROLES = new Set(['switch', 'checkbox', 'menuitemcheckbox']);

  /** Everything that could be a control, used to collect role candidates. */
  const CONTROL_SELECTOR = [
    '[role]',
    'a[href]',
    'area[href]',
    'button',
    'input:not([type="hidden" i])',
    'select',
    'textarea',
    'summary',
    'option',
    'dialog',
  ].join(',');

  /** "All interactive elements" (targets without role or selector). */
  const INTERACTIVE_SELECTOR = [
    CONTROL_SELECTOR,
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable=""]',
    '[contenteditable="true" i]',
    '[onclick]',
  ].join(',');

  const STATEFUL_SELECTOR =
    'input[type="checkbox" i],input[type="radio" i],[role="switch"],[role="checkbox"],[role="menuitemcheckbox"],[aria-checked],[aria-pressed],[data-state]';

  const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],dialog[open]';

  const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link']);

  const BLOCK_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'br',
    'button',
    'dd',
    'details',
    'dialog',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'input',
    'label',
    'legend',
    'li',
    'main',
    'nav',
    'ol',
    'option',
    'p',
    'pre',
    'section',
    'select',
    'summary',
    'table',
    'tbody',
    'td',
    'textarea',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
  ]);

  class EngineError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'NoTrainEngineError';
      this.code = code;
    }
  }

  // ---------------------------------------------------------------------------
  // Small utilities

  const now = () => Date.now();

  function abortError(signal) {
    const reason = signal && signal.reason;
    if (reason instanceof Error && reason.name === 'AbortError') return reason;
    const err = new Error('Stopped');
    err.name = 'AbortError';
    return err;
  }

  function isAbortError(err) {
    return !!err && err.name === 'AbortError';
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError(signal);
  }

  /** Abortable sleep. */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      // rAF does not fire in background tabs; the timeout keeps runs moving.
      try {
        requestAnimationFrame(finish);
      } catch {
        /* no rAF */
      }
      setTimeout(finish, 50);
    });
  }

  const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

  /**
   * Case-insensitive, whitespace-normalised form used for all text matching.
   * Also folds typographic quotes and dashes so “Improve” matches "Improve".
   */
  function normalizeText(value) {
    let s = String(value == null ? '' : value);
    try {
      s = s.normalize('NFKC');
    } catch {
      /* keep as is */
    }
    return s
      .replace(ZERO_WIDTH, '')
      .replace(/[‘’‚‛′´`]/g, "'")
      .replace(/[“”„‟″«»]/g, '"')
      .replace(/[‐-―−]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** Whitespace-collapsed display text. */
  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(ZERO_WIDTH, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Composed-tree helpers (open shadow roots)

  function isShadowRoot(node) {
    return !!node && node.nodeType === 11 && !!node.host;
  }

  /** Parent element, stepping out of shadow roots to their host. */
  function parentOf(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const p = node.parentNode;
    return isShadowRoot(p) ? p.host : null;
  }

  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || (isShadowRoot(n) ? n.host : null)) {
      if (n === ancestor) return true;
    }
    return false;
  }

  /**
   * querySelectorAll that also searches open shadow roots below `scope`
   * (Document, ShadowRoot or Element). Throws EngineError for bad selectors.
   */
  function queryDeep(scope, selector) {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      let list;
      try {
        list = root.querySelectorAll(selector);
      } catch {
        throw new EngineError('bad_selector', `Invalid selector in recipe: ${selector}`);
      }
      for (const el of list) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (scope && scope.nodeType === 1 && scope.shadowRoot) visit(scope.shadowRoot);
    if (scope) visit(scope);
    return out;
  }

  function isOwnUi(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType === 1 && n.hasAttribute(UI_ATTR)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Text

  /**
   * Rendered-order text of a node (flat tree: shadow content and slotted
   * nodes, not light children a shadow root does not render). Stops once
   * `limit` characters were collected. With `forName`, descendants that have
   * an aria-label contribute that label (as in accessible-name computation).
   */
  function flatText(node, limit = Infinity, forName = false) {
    const parts = [];
    let len = 0;
    const push = (s) => {
      parts.push(s);
      len += s.length;
    };
    const visitChildren = (n) => {
      for (let c = n.firstChild; c && len <= limit; c = c.nextSibling) visit(c);
    };
    const visit = (n) => {
      if (len > limit) return;
      if (n.nodeType === 3) {
        if (n.data) push(n.data);
        return;
      }
      if (n.nodeType === 11) {
        visitChildren(n);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.localName;
      if (SKIP_TEXT_TAGS.has(tag) || n.hidden || n.hasAttribute(UI_ATTR)) return;
      const block = BLOCK_TAGS.has(tag);
      if (block) push(' ');
      if (forName && n !== node && n.getAttribute('aria-hidden') === 'true') {
        // Decorative content does not contribute to an accessible name.
      } else if (forName && n !== node && cleanText(n.getAttribute('aria-label'))) {
        push(` ${n.getAttribute('aria-label')} `);
      } else if (tag === 'img' || tag === 'area') {
        const alt = n.getAttribute('alt');
        if (alt) push(` ${alt} `);
      } else if (tag === 'input') {
        const type = (n.getAttribute('type') || 'text').toLowerCase();
        if ((type === 'button' || type === 'submit' || type === 'reset') && n.value) push(` ${n.value} `);
        else if (type === 'image' && n.getAttribute('alt')) push(` ${n.getAttribute('alt')} `);
      } else if (n.shadowRoot) {
        visitChildren(n.shadowRoot);
      } else if (tag === 'slot' && typeof n.assignedNodes === 'function') {
        const assigned = n.assignedNodes({ flatten: true });
        if (assigned.length) assigned.forEach(visit);
        else visitChildren(n);
      } else {
        visitChildren(n);
      }
      if (block) push(' ');
    };
    visit(node);
    return parts.join('');
  }

  function textForReference(el) {
    const label = cleanText(el.getAttribute('aria-label'));
    return label || flatText(el, 2000, true);
  }

  function idRefText(el, attr) {
    const ids = (el.getAttribute(attr) || '').trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const root = el.getRootNode();
    const parts = [];
    for (const id of ids) {
      let ref = null;
      try {
        ref = typeof root.getElementById === 'function' ? root.getElementById(id) : null;
      } catch {
        ref = null;
      }
      if (ref) parts.push(textForReference(ref));
    }
    return parts.join(' ');
  }

  /** Computed ARIA role (explicit if recognised, else implicit), or null. */
  function roleOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const attr = el.getAttribute('role');
    if (attr) {
      for (const r of attr.trim().toLowerCase().split(/\s+/)) {
        if (KNOWN_ARIA_ROLES.has(r)) {
          if (r === 'presentation' || r === 'none' || r === 'generic') break;
          return r;
        }
      }
    }
    const tag = el.localName;
    switch (tag) {
      case 'button':
      case 'summary':
        return 'button';
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null;
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return el.hasAttribute('switch') ? 'switch' : 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
        if (type === 'search') return 'searchbox';
        if (['text', 'email', 'tel', 'url', 'password', ''].includes(type)) return 'textbox';
        return null;
      }
      case 'select':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'option':
        return 'option';
      case 'dialog':
        return 'dialog';
      default:
        return null;
    }
  }

  /** Simplified accessible-name computation (accname 1.2 essentials). */
  function accessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    const labelledBy = cleanText(idRefText(el, 'aria-labelledby'));
    if (labelledBy) return labelledBy;
    const ariaLabel = cleanText(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const tag = el.localName;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const v = cleanText(el.value);
        if (v) return v;
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
      }
      if (type === 'image') {
        const alt = cleanText(el.getAttribute('alt'));
        if (alt) return alt;
      }
    }
    if (el.labels && el.labels.length) {
      const t = cleanText([...el.labels].map((l) => flatText(l, 2000, true)).join(' '));
      if (t) return t;
    }
    const role = roleOf(el);
    if (NAME_FROM_CONTENT.has(role) || tag === 'label' || tag === 'legend') {
      const t = cleanText(flatText(el, 2000, true));
      if (t) return t;
    }
    if (role === 'dialog' || role === 'alertdialog') {
      const heading = el.querySelector('h1,h2,h3,[role="heading"]');
      if (heading) {
        const t = cleanText(flatText(heading, 500, true));
        if (t) return t;
      }
    }
    const title = cleanText(el.getAttribute('title'));
    if (title) return title;
    const placeholder = cleanText(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    return '';
  }

  // ---------------------------------------------------------------------------
  // Visibility

  function styleOf(el) {
    try {
      return getComputedStyle(el);
    } catch {
      return null;
    }
  }

  let modalDialogCache = { at: -1, el: null };
  /** The open native modal <dialog> (everything outside it is inert), if any. */
  function openModalDialog() {
    const t = now();
    if (t - modalDialogCache.at < 30) return modalDialogCache.el;
    let el = null;
    try {
      el = document.querySelector('dialog:modal');
    } catch {
      el = null;
    }
    modalDialogCache = { at: t, el };
    return el;
  }

  /** Rendered as far as CSS display/visibility/content-visibility go. */
  function isRendered(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    }
    const cs = styleOf(el);
    if (!cs || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    for (let n = el; n && n.nodeType === 1; n = parentOf(n)) {
      const s = styleOf(n);
      if (s && s.display === 'none') return false;
    }
    return true;
  }

  function hasBox(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    // Positioned out of reach (e.g. left: -9999px): the page cannot be scrolled there.
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
    return true;
  }

  /** No transparent ancestor and not clipped away by an overflow container. */
  function notObscured(el) {
    const rect = el.getBoundingClientRect();
    let clipChecks = true;
    let depth = 0;
    for (let n = el; n && n.nodeType === 1 && depth < 80; n = parentOf(n), depth += 1) {
      const cs = styleOf(n);
      if (!cs) continue;
      if (parseFloat(cs.opacity) === 0) return false;
      if (n !== el && clipChecks && n !== document.body && n !== document.documentElement) {
        const ox = cs.overflowX;
        const oy = cs.overflowY;
        const clipX = ox === 'hidden' || ox === 'clip';
        const clipY = oy === 'hidden' || oy === 'clip';
        const scrollX = ox === 'auto' || ox === 'scroll';
        const scrollY = oy === 'auto' || oy === 'scroll';
        if (clipX || clipY || scrollX || scrollY) {
          const pr = n.getBoundingClientRect();
          if ((clipX || scrollX) && pr.width < 1) return false;
          if ((clipY || scrollY) && pr.height < 1) return false;
          if (clipX && (rect.right <= pr.left || rect.left >= pr.right)) return false;
          if (clipY && (rect.bottom <= pr.top || rect.top >= pr.bottom)) return false;
        }
      }
      // A fixed-position box escapes the overflow clipping of its ancestors.
      if (cs.position === 'fixed') clipChecks = false;
    }
    return true;
  }

  function isNativeToggleInput(el) {
    if (!el || el.localName !== 'input') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
  }

  /**
   * True if a person could see (and so could have meant) this element.
   * Excludes display:none/visibility:hidden, [hidden], inert and aria-hidden
   * subtrees, content outside an open modal <dialog>, zero-size and off-page
   * boxes, transparent subtrees and boxes clipped away by overflow. Native
   * checkboxes/radios that are styled invisible (the usual custom-switch
   * pattern) count as visible when their label or wrapper is visible.
   */
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      if (n.hasAttribute(UI_ATTR)) return false;
      if (n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true') return false;
    }
    const modal = openModalDialog();
    if (modal && !composedContains(modal, el)) return false;
    if (isNativeToggleInput(el)) {
      if (isRendered(el) && hasBox(el) && notObscured(el)) return true;
      // Custom-styled checkbox: the <label> (even for a display:none input) or,
      // for a transparent / clipped input, its wrapper is what people see.
      if ([...(el.labels || [])].some(showsBox)) return true;
      const parent = parentOf(el);
      return isRendered(el) && !!parent && parent.nodeType === 1 && showsBox(parent);
    }
    if (!isRendered(el)) return false;
    return hasBox(el) && notObscured(el);
  }

  function showsBox(el) {
    return isRendered(el) && hasBox(el) && notObscured(el);
  }

  // ---------------------------------------------------------------------------
  // Target resolution

  function normalizeTarget(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new EngineError('invalid_target', 'Recipe target must be an object');
    }
    const out = {};
    if (target.selector != null) {
      if (typeof target.selector !== 'string' || !target.selector.trim()) {
        throw new EngineError('invalid_target', 'Recipe target selector must be a non-empty string');
      }
      out.selector = target.selector;
    }
    if (target.role != null) {
      const role = String(target.role).toLowerCase();
      if (!ROLE_SETS[role]) throw new EngineError('invalid_target', `Unknown role in recipe: ${target.role}`);
      out.role = role;
    }
    if (target.text != null) {
      const list = Array.isArray(target.text) ? target.text : [target.text];
      const texts = list.map(normalizeText).filter(Boolean);
      if (!texts.length) throw new EngineError('invalid_target', 'Recipe target text is empty');
      out.text = texts;
      out.rawText = list.map(cleanText).filter(Boolean);
    }
    if (target.within != null) out.within = target.within;
    if (!out.selector && !out.role && !out.text && !out.within) {
      throw new EngineError('invalid_target', 'Recipe target needs a selector, role, text or within');
    }
    return out;
  }

  function scopeList(t, root, opts) {
    if (!t.within) return [root || document];
    return findAll(t.within, root, opts);
  }

  function uniq(list) {
    return [...new Set(list)];
  }

  /**
   * Scores a role/selector candidate against the target texts.
   * Tiers: 0 accessible name equals, 1 name contains, 2 own content contains
   * (e.g. a dialog), 3 row text contains. `len` breaks ties (shorter wins).
   */
  function scoreCandidate(el, texts, peers, opts) {
    let best = null;
    const consider = (tier, len) => {
      if (!best || tier < best.tier || (tier === best.tier && len < best.len)) best = { tier, len };
    };
    const name = normalizeText(accessibleName(el));
    if (name) {
      for (const t of texts) {
        if (name === t) consider(0, name.length);
        else if (name.includes(t)) consider(1, name.length);
      }
    }
    if (best) return best;
    const own = normalizeText(flatText(el, 4000));
    if (own && own.length <= 2000) {
      for (const t of texts) if (own.includes(t)) consider(2, own.length);
    }
    if (best || opts.rowText === false) return best;

    // Row text: the nearest ancestor (<= 5 levels) whose text is <= 300 chars.
    // An ancestor that also holds another visible candidate is a shared
    // container, not this control's row, so the walk stops there: a label
    // must never be attributed to the neighbouring control.
    let anc = parentOf(el);
    for (let level = 1; anc && level <= DEFAULTS.rowLevels; level += 1, anc = parentOf(anc)) {
      if (anc === document.body || anc === document.documentElement) break;
      const row = normalizeText(flatText(anc, DEFAULTS.rowMaxChars * 8));
      if (row.length > DEFAULTS.rowMaxChars) break;
      const shared = peers.some(
        (o) => o !== el && composedContains(anc, o) && !composedContains(el, o) && !composedContains(o, el),
      );
      if (shared) break;
      if (texts.some((t) => row.includes(t))) return { tier: 3, len: row.length };
    }
    return null;
  }

  function collectRoleOrSelector(t, scopes, roleList, opts) {
    const found = [];
    for (const scope of scopes) {
      const list = queryDeep(scope, t.selector || CONTROL_SELECTOR);
      for (const el of list) found.push(el);
    }
    let cands = uniq(found);
    if (roleList) cands = cands.filter((el) => roleList.includes(roleOf(el)));
    cands = cands.filter((el) => !isOwnUi(el) && isVisible(el));
    const reverse = !!t.role && ROLE_SETS[t.role].strict.includes('dialog');
    const matches = [];
    cands.forEach((el, i) => {
      const order = reverse ? -i : i; // the most recently opened dialog is usually on top
      if (!t.text) {
        matches.push({ el, tier: 0, len: 0, order, interactive: 1 });
        return;
      }
      const score = scoreCandidate(el, t.text, cands, opts);
      if (score) matches.push({ el, tier: score.tier, len: score.len, order, interactive: 1 });
    });
    return matches;
  }

  function walkTextNodes(scope, fn) {
    const start = scope.nodeType === 9 ? scope.body || scope.documentElement : scope;
    if (!start) return;
    const visitRoot = (root) => {
      const doc = root.ownerDocument || document;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 1) {
            if (SKIP_TEXT_TAGS.has(node.localName) || node.hasAttribute(UI_ATTR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const hosts = [];
      let n = walker.nextNode();
      while (n) {
        fn(n);
        n = walker.nextNode();
      }
      // Tree walkers do not enter shadow roots; do that separately.
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) if (el.shadowRoot) hosts.push(el.shadowRoot);
      if (root.nodeType === 1 && root.shadowRoot) hosts.push(root.shadowRoot);
      for (const sr of hosts) visitRoot(sr);
    };
    visitRoot(start);
  }

  function isInteractive(el) {
    try {
      return el.matches(INTERACTIVE_SELECTOR);
    } catch {
      return false;
    }
  }

  /** Text-only target: the smallest visible element whose own text contains a string. */
  function collectTextOnly(t, scopes) {
    const memo = new Map();
    const textOf = (el) => {
      let v = memo.get(el);
      if (v === undefined) {
        v = normalizeText(flatText(el, 8000));
        memo.set(el, v);
      }
      return v;
    };
    const found = new Map();
    let order = 0;
    const add = (el, tier, len) => {
      const prev = found.get(el);
      if (!prev || tier < prev.tier) {
        found.set(el, { el, tier, len, order: prev ? prev.order : order++, interactive: isInteractive(el) ? 0 : 1 });
      }
    };
    for (const scope of scopes) {
      const top = scope.nodeType === 9 ? null : scope;
      walkTextNodes(scope, (node) => {
        if (!node.data || !node.data.trim()) return;
        let el = node.parentElement || (isShadowRoot(node.parentNode) ? node.parentNode.host : null);
        for (let level = 0; el && level < 8; level += 1, el = parentOf(el)) {
          if (el === document.body || el === document.documentElement) break;
          if (top && !composedContains(top, el)) break;
          const txt = textOf(el);
          if (t.text.some((s) => txt.includes(s))) {
            add(el, t.text.includes(txt) ? 0 : 1, txt.length);
            break;
          }
          if (txt.length > 4000 || el === top) break;
        }
      });
      // Icon buttons and other controls named by aria-label / aria-labelledby.
      for (const el of queryDeep(scope, INTERACTIVE_SELECTOR)) {
        const name = normalizeText(accessibleName(el));
        if (!name) continue;
        if (t.text.includes(name)) add(el, 0, name.length);
        else if (t.text.some((s) => name.includes(s))) add(el, 1, name.length);
      }
    }
    return [...found.values()].filter((m) => !isOwnUi(m.el) && isVisible(m.el));
  }

  function collectInteractive(scopes) {
    const cands = uniq(scopes.flatMap((s) => queryDeep(s, INTERACTIVE_SELECTOR)));
    return cands
      .filter((el) => !isOwnUi(el) && isVisible(el))
      .map((el, i) => ({ el, tier: 0, len: 0, order: i, interactive: 0 }));
  }

  function sortMatches(matches) {
    return matches.sort(
      (a, b) => a.tier - b.tier || a.len - b.len || a.interactive - b.interactive || a.order - b.order,
    );
  }

  function rankMatches(target, root, opts = {}) {
    const t = normalizeTarget(target);
    const scopes = scopeList(t, root, opts);
    if (!scopes.length) return [];
    if (t.role || t.selector) {
      let matches = collectRoleOrSelector(t, scopes, t.role ? ROLE_SETS[t.role].strict : null, opts);
      if (!matches.length && t.role && ROLE_SETS[t.role].lenient.length) {
        matches = collectRoleOrSelector(t, scopes, ROLE_SETS[t.role].lenient, opts);
      }
      return sortMatches(matches);
    }
    if (t.text) return sortMatches(collectTextOnly(t, scopes));
    return sortMatches(collectInteractive(scopes));
  }

  /**
   * All visible elements matching a recipe target, best first.
   * @param {object} target `{ selector?, role?, text?, within? }`
   * @param {Document|ShadowRoot|Element} [root]
   * @param {{ rowText?: boolean }} [opts] rowText:false matches names only
   * @returns {Element[]}
   */
  function findAll(target, root = document, opts = {}) {
    return rankMatches(target, root || document, opts).map((m) => m.el);
  }

  /** The best visible match for a recipe target, or null. */
  function findTarget(target, root = document, opts = {}) {
    return findAll(target, root, opts)[0] || null;
  }

  // ---------------------------------------------------------------------------
  // Toggles

  function stateFromAttr(value) {
    if (value == null) return undefined;
    const v = value.trim().toLowerCase();
    if (v === 'true') return 'on';
    if (v === 'false') return 'off';
    if (v === 'mixed') return null;
    return undefined; // invalid value: treat as not set
  }

  function rawToggleState(el) {
    if (!el || el.nodeType !== 1) return null;
    // Browsers ignore aria-checked on native checkboxes, so the DOM state wins there.
    if (isNativeToggleInput(el)) return el.checked ? 'on' : 'off';
    const checked = stateFromAttr(el.getAttribute('aria-checked'));
    if (checked !== undefined) return checked;
    const pressed = stateFromAttr(el.getAttribute('aria-pressed'));
    if (pressed !== undefined) return pressed;
    const ds = (el.getAttribute('data-state') || '').trim().toLowerCase();
    if (ds === 'checked' || ds === 'on' || ds === 'active') return 'on';
    if (ds === 'unchecked' || ds === 'off' || ds === 'inactive') return 'off';
    return null;
  }

  /**
   * The element that actually carries the state: the element itself, the
   * control of a <label>, or the single stateful element inside a wrapper.
   */
  function toggleControl(el) {
    if (!el || el.nodeType !== 1) return null;
    if (rawToggleState(el) !== null) return el;
    if (el.localName === 'label' && el.control) return el.control;
    const inner = queryDeep(el, STATEFUL_SELECTOR).filter((n) => rawToggleState(n) !== null);
    if (inner.length === 1) return inner[0];
    return el;
  }

  /** 'on' | 'off' | null (unknown). */
  function readToggleState(el) {
    return rawToggleState(toggleControl(el));
  }

  function isDisabled(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.matches(':disabled')) return true;
    } catch {
      /* ignore */
    }
    return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
  }

  function isBusy(el) {
    let depth = 0;
    for (let n = el; n && depth < 4; n = parentOf(n), depth += 1) {
      if (n.nodeType === 1 && n.getAttribute('aria-busy') === 'true') return true;
    }
    return isDisabled(el);
  }

  /** Pressing it flips a state (so only setToggle may press it). */
  function isToggleLike(el) {
    if (!el || el.nodeType !== 1) return false;
    if (TOGGLE_ROLES.has(roleOf(el))) return true;
    if (el.localName === 'label' && el.control && TOGGLE_ROLES.has(roleOf(el.control))) return true;
    const pressed = (el.getAttribute('aria-pressed') || '').toLowerCase();
    if (pressed === 'true' || pressed === 'false') return true;
    const ds = (el.getAttribute('data-state') || '').toLowerCase();
    return ds === 'checked' || ds === 'unchecked' || ds === 'on' || ds === 'off';
  }

  // ---------------------------------------------------------------------------
  // Login

  /**
   * True if any login indicator is visible. Indicators match by accessible
   * name / own text only (no row text), so a "Sign in" mention next to some
   * unrelated button on a signed-in page is not mistaken for a login wall.
   */
  function checkLogin(indicators, root = document) {
    if (!Array.isArray(indicators) || !indicators.length) return false;
    for (const ind of indicators) {
      try {
        if (findAll(ind, root, { rowText: false }).length) return true;
      } catch {
        /* a broken indicator must not break the run */
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Waiting

  /**
   * Waits until `target` has a visible match (MutationObserver + polling, so
   * changes inside shadow roots and CSS-only changes are seen too).
   * Never modifies the page.
   * @returns {Promise<{ element: Element|null, needsLogin?: boolean }>}
   *   rejects with an AbortError if `signal` aborts
   */
  function waitForTarget(target, options = {}) {
    const {
      timeoutMs = DEFAULTS.waitForTimeoutMs,
      signal,
      root = document,
      filter,
      loginIndicators,
      loginGraceMs = DEFAULTS.loginGraceMs,
      pollMs = DEFAULTS.pollMs,
    } = options;
    normalizeTarget(target); // validate up front: a broken recipe fails fast
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      let done = false;
      let observer = null;
      let interval = null;
      let timer = null;
      let pending = null;
      let lastCheck = 0;
      let loginSince = null;
      const hasLogin = Array.isArray(loginIndicators) && loginIndicators.length > 0;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(pending);
        clearInterval(interval);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const finish = (value, err) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => finish(null, abortError(signal));
      const check = () => {
        pending = null;
        if (done) return;
        lastCheck = now();
        let el = null;
        try {
          const all = findAll(target, root);
          el = filter ? all.find(filter) || null : all[0] || null;
        } catch (err) {
          finish(null, err);
          return;
        }
        if (el) {
          finish({ element: el });
          return;
        }
        if (hasLogin) {
          if (checkLogin(loginIndicators, root)) {
            if (loginSince == null) loginSince = now();
            if (now() - loginSince >= loginGraceMs) finish({ element: null, needsLogin: true });
          } else {
            loginSince = null;
          }
        }
      };
      const schedule = () => {
        if (done || pending) return;
        const gap = Math.max(0, DEFAULTS.minCheckGapMs - (now() - lastCheck));
        pending = setTimeout(check, gap);
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      check();
      if (done) return;
      try {
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement || document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        observer = null;
      }
      interval = setInterval(check, pollMs);
      timer = setTimeout(() => {
        check();
        if (!done) finish({ element: null, needsLogin: hasLogin && checkLogin(loginIndicators, root) });
      }, Math.max(0, timeoutMs));
    });
  }

  /** Resolves once the DOM has been quiet for `quietMs` (or after `maxMs`). */
  function settle(signal, quietMs = DEFAULTS.settleQuietMs, maxMs = DEFAULTS.settleMaxMs) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      let quiet = null;
      let observer = null;
      const finish = (err) => {
        clearTimeout(quiet);
        clearTimeout(hard);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish(abortError(signal));
      const arm = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(), quietMs);
      };
      const hard = setTimeout(() => finish(), maxMs);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        observer = new MutationObserver(arm);
        observer.observe(document.documentElement || document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        observer = null;
      }
      arm();
    });
  }

  // ---------------------------------------------------------------------------
  // Clicking

  function isFocusable(el) {
    if (!el || el.nodeType !== 1 || typeof el.focus !== 'function') return false;
    if (isDisabled(el)) return false;
    return el.tabIndex >= 0 || el.hasAttribute('tabindex');
  }

  function focusNearest(el) {
    let depth = 0;
    for (let n = el; n && depth < 6; n = parentOf(n), depth += 1) {
      if (isFocusable(n)) {
        try {
          n.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  function makeEvent(Ctor, type, init) {
    try {
      return new Ctor(type, init);
    } catch {
      try {
        return new MouseEvent(type, init);
      } catch {
        return null;
      }
    }
  }

  /**
   * Clicks like a person would: scroll into view, hover, pointer/mouse down,
   * focus, pointer/mouse up, click. Falls back to element.click() if the
   * synthetic click cannot be dispatched.
   * @returns {Promise<void>}
   */
  async function clickElement(el, signal) {
    throwIfAborted(signal);
    if (!el || !el.isConnected) throw new EngineError('detached', 'The element disappeared before it could be clicked');
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* not scrollable */
      }
    }
    await nextFrame();
    throwIfAborted(signal);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX || 0),
      screenY: y + (window.screenY || 0),
      button: 0,
    };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const fire = (Ctor, type, init) => {
      const ev = makeEvent(Ctor, type, init);
      if (!ev) return true;
      try {
        return el.dispatchEvent(ev);
      } catch {
        return true;
      }
    };
    fire(P, 'pointerover', { ...pointer, buttons: 0 });
    fire(P, 'pointerenter', { ...pointer, bubbles: false, cancelable: false, buttons: 0 });
    fire(MouseEvent, 'mouseover', { ...base, buttons: 0 });
    fire(MouseEvent, 'mouseenter', { ...base, bubbles: false, cancelable: false, buttons: 0 });
    fire(P, 'pointermove', { ...pointer, buttons: 0 });
    fire(MouseEvent, 'mousemove', { ...base, buttons: 0 });
    const downOk = fire(P, 'pointerdown', { ...pointer, buttons: 1, pressure: 0.5 });
    // A cancelled pointerdown suppresses the compatibility mouse events (but not click).
    const mouseDownOk = downOk ? fire(MouseEvent, 'mousedown', { ...base, buttons: 1, detail: 1 }) : false;
    if (mouseDownOk) focusNearest(el);
    fire(P, 'pointerup', { ...pointer, buttons: 0, pressure: 0 });
    if (downOk) fire(MouseEvent, 'mouseup', { ...base, buttons: 0, detail: 1 });
    if (!el.isConnected) return; // the press itself handled it (e.g. menus that act on pointerdown)
    const click = makeEvent(P, 'click', { ...pointer, buttons: 0, detail: 1 });
    let dispatched = false;
    if (click) {
      try {
        el.dispatchEvent(click);
        dispatched = true;
      } catch {
        dispatched = false;
      }
    }
    if (!dispatched && typeof el.click === 'function') el.click();
  }

  /** For a text-only match (e.g. a <span>), the control a person would press. */
  function clickableFor(el) {
    let depth = 0;
    for (let n = el; n && depth < 4; n = parentOf(n), depth += 1) {
      if (n.nodeType === 1 && isInteractive(n)) return n;
    }
    return el;
  }

  function firstVisibleLabel(control) {
    const labels = control && control.labels ? [...control.labels] : [];
    return labels.find(showsBox) || null;
  }

  /** Where to press a toggle: the control, or its label if the control itself is invisible. */
  function primaryToggleTarget(control) {
    if (isNativeToggleInput(control) && !showsBox(control)) {
      const label = firstVisibleLabel(control);
      if (label) return label;
    }
    return control;
  }

  // ---------------------------------------------------------------------------
  // Highlight (read-only visual aid; never changes page elements)

  let hl = null;

  function prefersReducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function clearHighlight() {
    if (!hl) return;
    const { host, raf } = hl;
    hl = null;
    try {
      cancelAnimationFrame(raf);
    } catch {
      /* ignore */
    }
    clearInterval(host.__ntTimer);
    host.remove();
  }

  /**
   * Draws a ring around `el` (in a closed shadow root appended to <html>),
   * following it as the page scrolls. Returns false if `el` is not visible.
   * @param {Element} el
   * @param {{ label?: string, scroll?: boolean }} [options]
   */
  function highlight(el, options = {}) {
    clearHighlight();
    if (!el || !el.isConnected) return false;
    const reduced = prefersReducedMotion();
    if (options.scroll) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
        } catch {
          /* ignore */
        }
      }
    }
    const host = document.createElement('notrain-highlight');
    host.setAttribute(UI_ATTR, 'highlight');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 0',
      'height: 0',
      'overflow: visible',
      'z-index: 2147483646',
      'pointer-events: none',
      'display: block',
      'contain: layout style',
    ]
      .map((d) => `${d} !important`)
      .join(';');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .ring {
        position: fixed; top: 0; left: 0; box-sizing: border-box; pointer-events: none;
        border: 3px solid #4f46e5; border-radius: 10px;
        box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.22), 0 0 24px rgba(79, 70, 229, 0.35);
        transition: opacity 120ms ease; opacity: 0;
      }
      .ring.show { opacity: 1; }
      .ring.pulse { animation: nt-pulse 1.6s ease-in-out infinite; }
      @keyframes nt-pulse {
        0%, 100% { box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.22), 0 0 24px rgba(79, 70, 229, 0.35); }
        50% { box-shadow: 0 0 0 9px rgba(79, 70, 229, 0.12), 0 0 30px rgba(79, 70, 229, 0.3); }
      }
      .tag {
        position: fixed; top: 0; left: 0; pointer-events: none; white-space: nowrap;
        font: 600 12px/1.2 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif;
        color: #ffffff; background: #4f46e5; padding: 4px 8px; border-radius: 6px;
        box-shadow: 0 2px 8px rgba(15, 23, 42, 0.25); opacity: 0;
      }
      .tag.show { opacity: 1; }
      @media (prefers-color-scheme: dark) {
        .ring { border-color: #818cf8; box-shadow: 0 0 0 4px rgba(129, 140, 248, 0.28), 0 0 24px rgba(129, 140, 248, 0.4); }
        .tag { background: #818cf8; color: #0b1020; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ring, .tag { transition: none; }
        .ring.pulse { animation: none; }
      }
    `;
    const ring = document.createElement('div');
    ring.className = reduced ? 'ring' : 'ring pulse';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = options.label ? String(options.label).slice(0, 60) : '';
    root.append(style, ring, tag);
    (document.documentElement || document.body).appendChild(host);

    const state = { host, el, raf: 0 };
    hl = state;
    let last = '';
    const place = () => {
      if (hl !== state) return;
      const target = state.el;
      const ok = target.isConnected && isRendered(target);
      const r = ok ? target.getBoundingClientRect() : null;
      const key = r ? `${r.left}|${r.top}|${r.width}|${r.height}` : 'none';
      if (key !== last) {
        last = key;
        if (!r || r.width === 0 || r.height === 0) {
          ring.classList.remove('show');
          tag.classList.remove('show');
        } else {
          const pad = 4;
          ring.style.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
          ring.style.width = `${Math.round(r.width + pad * 2)}px`;
          ring.style.height = `${Math.round(r.height + pad * 2)}px`;
          ring.classList.add('show');
          if (tag.textContent) {
            const above = r.top - pad - 28 >= 4;
            const ty = above ? r.top - pad - 28 : r.bottom + pad + 6;
            const tx = Math.max(4, Math.min(r.left - pad, innerWidth - 200));
            tag.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
            tag.classList.add('show');
          }
        }
      }
      state.raf = requestAnimationFrame(place);
    };
    // rAF pauses in background tabs; a slow timer keeps the ring roughly right.
    host.__ntTimer = setInterval(() => {
      if (hl === state && document.hidden) place();
    }, 500);
    place();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Step descriptions and messages

  function targetLabel(target) {
    if (!target || typeof target !== 'object') return 'the setting';
    const text = Array.isArray(target.text) ? target.text[0] : target.text;
    if (text) return cleanText(text);
    if (target.within) return targetLabel(target.within);
    if (target.role) return `the ${target.role}`;
    return 'the setting';
  }

  /** Default human-readable description of a step (used when the recipe has none). */
  function describeStep(step) {
    if (!step || typeof step !== 'object') return 'Working';
    if (step.description) return cleanText(step.description);
    const label = targetLabel(step.target);
    switch (step.action) {
      case 'waitFor':
        return `Waiting for “${label}” to appear`;
      case 'click':
        return `Clicking “${label}”`;
      case 'setToggle':
        return `Turning ${step.state === 'on' ? 'on' : 'off'} “${label}”`;
      case 'assertToggle':
        return `Checking that “${label}” is ${step.state === 'on' ? 'on' : 'off'}`;
      case 'wait':
        return 'Waiting for the page';
      default:
        return 'Working';
    }
  }

  // ---------------------------------------------------------------------------
  // Running steps

  function stepResult(outcome, message) {
    return { status: 'failed', outcome, message };
  }

  function visibleDialogs() {
    try {
      return queryDeep(document, DIALOG_SELECTOR).filter((d) => !isOwnUi(d) && isVisible(d));
    } catch {
      return [];
    }
  }

  function currentControl(control, target) {
    if (control && control.isConnected) return control;
    try {
      const el = findTarget(target);
      return el ? toggleControl(el) : null;
    } catch {
      return null;
    }
  }

  /**
   * After a toggle was pressed: resolves 'flipped' when it reaches `desired`,
   * 'dialog' when a new dialog opened instead (a confirmation step), or
   * 'busy' / 'unchanged' after `timeoutMs`.
   */
  function waitForFlip(control, target, desired, timeoutMs, dialogsBefore, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      let done = false;
      let observer = null;
      let pending = null;
      let latest = control;
      const finish = (value, err) => {
        if (done) return;
        done = true;
        clearInterval(interval);
        clearTimeout(timer);
        clearTimeout(pending);
        if (observer) observer.disconnect();
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => finish(null, abortError(signal));
      const check = () => {
        pending = null;
        if (done) return;
        latest = currentControl(latest, target);
        if (latest && rawToggleState(latest) === desired) {
          finish('flipped');
          return;
        }
        if (visibleDialogs().some((d) => !dialogsBefore.has(d))) finish('dialog');
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const interval = setInterval(check, 100);
      const timer = setTimeout(() => {
        check();
        if (!done) finish(latest && isBusy(latest) ? 'busy' : 'unchanged');
      }, Math.max(0, timeoutMs));
      try {
        observer = new MutationObserver(() => {
          if (!pending) pending = setTimeout(check, 30);
        });
        observer.observe(document.documentElement || document, {
          subtree: true,
          childList: true,
          attributes: true,
        });
      } catch {
        observer = null;
      }
      check();
    });
  }

  /** Polls (re-resolving the target) until the toggle reads `desired`. */
  async function waitForState(target, desired, timeoutMs, signal) {
    const end = now() + timeoutMs;
    let seen = null;
    for (;;) {
      throwIfAborted(signal);
      let el = null;
      try {
        el = findTarget(target);
      } catch {
        el = null;
      }
      if (el) {
        seen = readToggleState(el);
        if (seen === desired) return { found: true, state: seen };
      }
      if (now() >= end) return { found: !!el, state: seen };
      await sleep(150, signal);
    }
  }

  async function runWaitFor(step, ctx) {
    const res = await waitForTarget(step.target, {
      timeoutMs: step.timeoutMs ?? DEFAULTS.waitForTimeoutMs,
      signal: ctx.signal,
      loginIndicators: ctx.loginIndicators,
    });
    if (res.element) return { status: 'done', element: res.element };
    return missing(step, res);
  }

  function missing(step, res) {
    if (res.needsLogin) return stepResult(OUTCOMES.needsLogin, 'You need to sign in first.');
    if (step.optional) return { status: 'skipped' };
    return stepResult(OUTCOMES.notFound, `Couldn't find “${targetLabel(step.target)}” on this page.`);
  }

  async function runClick(step, ctx) {
    const timeoutMs =
      step.timeoutMs ?? (step.optional ? DEFAULTS.optionalClickTimeoutMs : DEFAULTS.clickTimeoutMs);
    // A click never presses a switch/checkbox: that is setToggle's job.
    const filter = (el) => !isToggleLike(el) && !isToggleLike(clickableFor(el));
    const res = await waitForTarget(step.target, {
      timeoutMs,
      signal: ctx.signal,
      loginIndicators: ctx.loginIndicators,
      filter,
    });
    if (!res.element) return missing(step, res);
    const el = clickableFor(res.element);
    if (ctx.highlight) highlight(el);
    await clickElement(el, ctx.signal);
    await settle(ctx.signal);
    return { status: 'done', element: el };
  }

  async function runAssertToggle(step, ctx) {
    const res = await waitForTarget(step.target, {
      timeoutMs: step.timeoutMs ?? DEFAULTS.assertTimeoutMs,
      signal: ctx.signal,
      loginIndicators: ctx.loginIndicators,
    });
    if (!res.element) return missing(step, res);
    const label = targetLabel(step.target);
    const state = readToggleState(res.element);
    if (state === null) return stepResult(OUTCOMES.failed, `Couldn't tell whether “${label}” is on or off.`);
    if (state !== step.state) {
      return {
        ...stepResult(OUTCOMES.mismatch, `“${label}” is ${state}, but it should be ${step.state}.`),
        toggle: true,
        state,
      };
    }
    return { status: 'done', toggle: true, changed: false, state, element: res.element };
  }

  async function runSetToggle(step, ctx) {
    if (ctx.readOnly) return runAssertToggle(step, ctx);
    const { signal } = ctx;
    const desired = step.state;
    const label = targetLabel(step.target);
    const flipTimeout = step.timeoutMs ?? DEFAULTS.toggleTimeoutMs;
    const res = await waitForTarget(step.target, {
      timeoutMs: step.timeoutMs ?? DEFAULTS.toggleTimeoutMs,
      signal,
      loginIndicators: ctx.loginIndicators,
    });
    if (!res.element) return missing(step, res);
    let control = toggleControl(res.element);
    const state = rawToggleState(control);
    if (state === null) return stepResult(OUTCOMES.failed, `Couldn't tell whether “${label}” is on or off.`);
    if (state === desired) return { status: 'done', toggle: true, changed: false, element: control };
    if (isDisabled(control)) {
      return stepResult(
        OUTCOMES.failed,
        `“${label}” can't be changed on this page (it is locked, or managed by an administrator).`,
      );
    }

    const dialogsBefore = new Set(visibleDialogs());
    const first = primaryToggleTarget(control);
    if (ctx.highlight) highlight(first);
    await clickElement(first, signal);
    let outcome = await waitForFlip(control, step.target, desired, flipTimeout, dialogsBefore, signal);
    if (outcome === 'busy') {
      // The site is saving: give it more time, never press twice while it works.
      outcome = await waitForFlip(control, step.target, desired, flipTimeout, dialogsBefore, signal);
    }
    if (outcome === 'unchanged') {
      // Nothing at all happened: the press did not reach the site's handler.
      // Try the other way a person could press it (the label, or a plain click()).
      control = currentControl(control, step.target);
      if (control && rawToggleState(control) !== desired && !isDisabled(control)) {
        const label2 = first === control ? firstVisibleLabel(control) : null;
        if (label2 && label2 !== first) await clickElement(label2, signal);
        else control.click();
        outcome = await waitForFlip(control, step.target, desired, flipTimeout, dialogsBefore, signal);
      }
    }
    if (outcome === 'dialog') {
      // A confirmation dialog opened; the following recipe steps confirm it and
      // runSteps checks the final state at the end.
      await settle(signal);
      return { status: 'pending', toggle: true, changed: true, pending: { target: step.target, desired, label } };
    }
    if (outcome !== 'flipped') {
      return stepResult(OUTCOMES.failed, `“${label}” didn't change when NoTrain pressed it.`);
    }
    // Make sure it sticks (some sites revert when the save fails).
    await sleep(DEFAULTS.stableMs, signal);
    const after = await waitForState(step.target, desired, Math.min(flipTimeout, 2000), signal);
    if (after.found && after.state !== desired) {
      return stepResult(OUTCOMES.failed, `The site switched “${label}” back ${after.state}.`);
    }
    await settle(signal);
    return { status: 'done', toggle: true, changed: true, element: control };
  }

  async function runStep(step, ctx) {
    if (!step || typeof step !== 'object') return stepResult(OUTCOMES.failed, 'Invalid recipe step.');
    switch (step.action) {
      case 'waitFor':
        return runWaitFor(step, ctx);
      case 'click':
        if (ctx.passive) return { status: 'skipped' };
        return runClick(step, ctx);
      case 'setToggle':
        if (step.state !== 'on' && step.state !== 'off') return stepResult(OUTCOMES.failed, 'Invalid toggle state in recipe.');
        return runSetToggle(step, ctx);
      case 'assertToggle':
        if (step.state !== 'on' && step.state !== 'off') return stepResult(OUTCOMES.failed, 'Invalid toggle state in recipe.');
        return runAssertToggle(step, ctx);
      case 'wait':
        await sleep(Math.min(Math.max(Number(step.ms) || 0, 0), 10000), ctx.signal);
        return { status: 'done' };
      default:
        return stepResult(OUTCOMES.failed, `Unknown recipe action: ${String(step.action)}`);
    }
  }

  /**
   * Runs recipe steps.
   * @param {object[]} steps automation.steps or automation.verify
   * @param {{
   *   signal?: AbortSignal,
   *   onProgress?: (p: { stepIndex: number, total: number, description: string, action: string,
   *                      status: 'running'|'done'|'skipped'|'pending'|'failed' }) => void,
   *   mode?: 'auto'|'verify',   // verify never changes a toggle (setToggle acts as assertToggle)
   *   loginIndicators?: object[],
   *   highlight?: boolean,       // ring the element being pressed
   * }} [options]
   * @returns {Promise<{ outcome: string, message: string, failedStep?: number }>}
   */
  async function runSteps(steps, options = {}) {
    const { signal, onProgress, mode = 'auto', loginIndicators = [], highlight: showHighlight = false } = options;
    const ctx = {
      signal,
      readOnly: mode === 'verify',
      passive: mode === 'passive',
      loginIndicators: Array.isArray(loginIndicators) ? loginIndicators : [],
      highlight: !!showHighlight,
    };
    if (!Array.isArray(steps) || steps.length === 0) {
      return { outcome: OUTCOMES.failed, message: 'This recipe has no steps.' };
    }
    const total = steps.length;
    const emit = (stepIndex, status) => {
      if (typeof onProgress !== 'function') return;
      try {
        const step = steps[stepIndex];
        onProgress({ stepIndex, total, description: describeStep(step), action: step && step.action, status });
      } catch {
        /* a broken listener must not break the run */
      }
    };
    let index = -1;
    let toggles = 0;
    let changed = false;
    let lastToggleLabel = null;
    let lastToggleState = null;
    const pendings = [];
    try {
      throwIfAborted(signal);
      // Signed out? Give a single-page app a moment to finish rendering first.
      if (ctx.loginIndicators.length && checkLogin(ctx.loginIndicators)) {
        await sleep(DEFAULTS.loginGraceMs, signal);
        const firstTargeted = steps.find((s) => s && s.target && s.action !== 'wait');
        let targetShown = false;
        try {
          targetShown = !!(firstTargeted && findTarget(firstTargeted.target));
        } catch {
          targetShown = false;
        }
        if (checkLogin(ctx.loginIndicators) && !targetShown) {
          return { outcome: OUTCOMES.needsLogin, message: 'You need to sign in first.', failedStep: 0 };
        }
      }
      for (index = 0; index < total; index += 1) {
        throwIfAborted(signal);
        const step = steps[index];
        emit(index, 'running');
        const r = await runStep(step, ctx);
        if (r.status === 'failed') {
          emit(index, 'failed');
          return { outcome: r.outcome, message: r.message, failedStep: index };
        }
        if (r.toggle) {
          toggles += 1;
          lastToggleLabel = targetLabel(step.target);
          lastToggleState = step.state;
        }
        if (r.changed) changed = true;
        if (r.pending) pendings.push(r.pending);
        emit(index, r.status);
      }
      index = total;
      for (const p of pendings) {
        const res = await waitForState(p.target, p.desired, DEFAULTS.toggleTimeoutMs, signal);
        if (res.found && res.state !== p.desired) {
          return {
            outcome: OUTCOMES.failed,
            message: `“${p.label}” is still ${res.state}: the change wasn't confirmed.`,
          };
        }
      }
      if (ctx.readOnly) {
        return {
          outcome: OUTCOMES.success,
          message: lastToggleLabel ? `“${lastToggleLabel}” is ${lastToggleState}.` : 'Checked.',
        };
      }
      if (toggles > 0 && !changed) {
        return { outcome: OUTCOMES.already, message: `“${lastToggleLabel}” was already ${lastToggleState}.` };
      }
      return {
        outcome: OUTCOMES.success,
        message: lastToggleLabel ? `“${lastToggleLabel}” is now ${lastToggleState}.` : 'Done.',
      };
    } catch (err) {
      if (isAbortError(err) || (signal && signal.aborted)) {
        return { outcome: OUTCOMES.cancelled, message: 'Stopped.', ...(index >= 0 && index < total ? { failedStep: index } : {}) };
      }
      const message = err instanceof EngineError ? err.message : `Unexpected error: ${(err && err.message) || err}`;
      return { outcome: OUTCOMES.failed, message, ...(index >= 0 && index < total ? { failedStep: index } : {}) };
    } finally {
      if (ctx.highlight) clearHighlight();
    }
  }

  globalThis.NoTrainEngine = Object.freeze({
    VERSION,
    OUTCOMES,
    DEFAULTS,
    UI_ATTR,
    findTarget,
    findAll,
    readToggleState,
    checkLogin,
    runSteps,
    waitForTarget,
    highlight,
    clearHighlight,
    describeStep,
    accessibleName,
    roleOf,
    isVisible,
    normalizeText,
  });
})();
