// Toast notifications. Messages are also announced through a polite live
// region, so screen-reader users hear results of async actions.

import { h } from './dom.js';
import { icon } from './icons.js';

let toaster = null;
let politeRegion = null;
let assertiveRegion = null;

function ensureRegions() {
  if (toaster && document.body.contains(toaster)) return;
  toaster = h('div', { class: 'nt-toaster', 'data-testid': 'toaster' });
  politeRegion = h('div', { class: 'nt-visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  assertiveRegion = h('div', { class: 'nt-visually-hidden', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  document.body.append(toaster, politeRegion, assertiveRegion);
}

/**
 * Announce text to screen readers without showing anything.
 * @param {string} message
 * @param {'polite'|'assertive'} [priority]
 */
export function announce(message, priority = 'polite') {
  ensureRegions();
  const region = priority === 'assertive' ? assertiveRegion : politeRegion;
  region.textContent = '';
  // A tick later so repeated identical messages are re-announced.
  setTimeout(() => {
    region.textContent = message;
  }, 30);
}

const TONE_ICONS = { good: 'checkCircle', bad: 'alertCircle', warn: 'alert', info: 'info' };

/**
 * @param {string} message
 * @param {{ tone?: 'good'|'bad'|'warn'|'info', duration?: number, action?: { label: string, onClick: () => void } }} [opts]
 * @returns {() => void} dismiss
 */
export function toast(message, { tone = 'good', duration = 4200, action } = {}) {
  ensureRegions();
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    const done = () => el.remove();
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  };
  const el = h(
    'div',
    { class: ['nt-toast', `nt-toast--${tone}`], 'data-testid': 'toast' },
    icon(TONE_ICONS[tone] ?? 'info'),
    h('span', { class: 'nt-toast__text' }, message),
    action &&
      h(
        'button',
        {
          type: 'button',
          class: 'nt-toast__action',
          onClick: () => {
            dismiss();
            action.onClick();
          },
        },
        action.label,
      ),
    h('button', { type: 'button', class: 'nt-toast__close', 'aria-label': 'Dismiss notification', onClick: dismiss }, icon('x', { size: 16 })),
  );
  // Keep at most three on screen.
  while (toaster.children.length >= 3) toaster.firstElementChild.remove();
  toaster.append(el);
  announce(message, tone === 'bad' ? 'assertive' : 'polite');
  const start = () => {
    clearTimeout(timer);
    if (duration > 0) timer = setTimeout(dismiss, action ? duration + 2000 : duration);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', start);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', start);
  start();
  return dismiss;
}
