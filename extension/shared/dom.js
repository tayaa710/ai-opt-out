// Safe DOM builder. Never uses innerHTML: every string child becomes a text
// node and every attribute is set with setAttribute, so registry and user data
// (which is remote / untrusted) can't inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Properties set as DOM properties rather than attributes. */
const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'disabled', 'open', 'multiple']);

/** Only these URL schemes may be used in href/src built from data. */
const SAFE_URL = /^(https:|mailto:|blob:|chrome-extension:|moz-extension:|#|\.{0,2}\/|[a-z0-9._-]+\.html)/i;

function setAttr(el, key, value) {
  if (value === undefined || value === null || value === false) return;
  if (key === 'class' || key === 'className') {
    const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    if (cls) el.setAttribute('class', cls);
    return;
  }
  if (key === 'dataset') {
    for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = String(v);
    return;
  }
  if (key === 'style' && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      if (k.startsWith('--')) el.style.setProperty(k, String(v));
      else el.style[k] = v;
    }
    return;
  }
  if (key.startsWith('on') && typeof value === 'function') {
    el.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (key === 'ref' && typeof value === 'function') {
    value(el);
    return;
  }
  if ((key === 'href' || key === 'src' || key === 'action') && !SAFE_URL.test(String(value))) {
    // Drop unsafe URLs (javascript:, data:, http: …) instead of rendering them.
    return;
  }
  if (PROPS.has(key)) {
    el[key] = value;
    return;
  }
  el.setAttribute(key, value === true ? '' : String(value));
}

function append(el, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(el, c);
    return;
  }
  if (child instanceof Node) {
    el.appendChild(child);
    return;
  }
  el.appendChild(document.createTextNode(String(child)));
}

/**
 * Create an HTML element.
 *   h('button', { class: 'nt-btn', onClick: fn, 'aria-label': 'Close' }, 'Close')
 * @param {string} tag
 * @param {object|null} [attrs]
 * @param {...any} children strings/numbers become text nodes; arrays are flattened; null/false skipped
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
  } else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) setAttr(el, k, v);
  }
  append(el, children);
  return el;
}

/** Create an SVG element (same signature as h). */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace all children with the given ones. */
export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** A document fragment from children. */
export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

let idCounter = 0;
/** Unique DOM id with a readable prefix. */
export function uid(prefix = 'nt') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Is a URL safe to open (https or mailto only)? Registry URLs are untrusted. */
export function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** External link that opens in a new tab with rel=noopener. Falls back to text if the URL is unsafe. */
export function extLink(url, label, attrs = {}) {
  if (!isSafeExternalUrl(url)) return h('span', attrs, label ?? url);
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', ...attrs }, label ?? url);
}

function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${el.id}`;
  if (el.dataset?.key) return `k:${el.dataset.key}`;
  const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '';
  const scope = el.closest('[data-key]')?.dataset.key ?? '';
  return `t:${scope}|${el.tagName}|${label}`;
}

function findByKey(root, key) {
  if (key.startsWith('#')) return document.getElementById(key.slice(1));
  if (key.startsWith('k:')) return root.querySelector(`[data-key="${CSS.escape(key.slice(2))}"]`);
  const [scope, tag, label] = key.slice(2).split('|');
  const candidates = Array.from(root.querySelectorAll(tag));
  return (
    candidates.find((c) => {
      const cl = c.getAttribute('aria-label') || c.textContent?.trim().slice(0, 60) || '';
      const cs = c.closest('[data-key]')?.dataset.key ?? '';
      return cl === label && cs === scope;
    }) ?? null
  );
}

/**
 * Re-render `root` with `fn` while keeping keyboard focus (and caret) on the
 * equivalent element, so live updates never throw keyboard users back to the top.
 */
export function preserveFocus(root, fn) {
  const active = document.activeElement;
  const inside = active && root.contains(active);
  const key = inside ? focusKey(active) : null;
  let sel = null;
  if (inside && typeof active.selectionStart === 'number') {
    try {
      sel = [active.selectionStart, active.selectionEnd];
    } catch {
      sel = null;
    }
  }
  const out = fn();
  if (key) {
    const next = findByKey(root, key);
    if (next && next !== document.activeElement) {
      next.focus({ preventScroll: true });
      if (sel && typeof next.setSelectionRange === 'function') {
        try {
          next.setSelectionRange(sel[0], sel[1]);
        } catch {
          // Not all input types support selection.
        }
      }
    }
  }
  return out;
}
