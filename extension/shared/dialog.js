// Modal confirm dialog built on <dialog> (focus trapping and Esc handling
// come from the platform). Resolves true when confirmed.

import { h, uid } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {{ title: string, body?: string|Node, confirmLabel?: string, cancelLabel?: string, tone?: 'primary'|'danger', iconName?: string }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', iconName }) {
  return new Promise((resolve) => {
    const titleId = uid('dlg-title');
    const bodyId = uid('dlg-body');
    let result = false;
    const cancelBtn = h('button', { type: 'button', class: 'nt-btn nt-btn--secondary', value: 'cancel' }, cancelLabel);
    const confirmBtn = h(
      'button',
      { type: 'button', class: ['nt-btn', tone === 'danger' ? 'nt-btn--danger' : 'nt-btn--primary'], value: 'confirm' },
      confirmLabel,
    );
    const dialog = h(
      'dialog',
      { class: 'nt-dialog', 'aria-labelledby': titleId, 'aria-describedby': body ? bodyId : null },
      h(
        'div',
        { class: 'nt-dialog__body' },
        h(
          'div',
          { class: ['nt-dialog__icon', tone === 'danger' && 'nt-dialog__icon--bad'] },
          icon(iconName ?? (tone === 'danger' ? 'alert' : 'info')),
        ),
        h('h2', { class: 'nt-dialog__title', id: titleId }, title),
        body && h('div', { class: 'nt-dialog__text', id: bodyId }, body),
      ),
      h('div', { class: 'nt-dialog__actions' }, cancelBtn, confirmBtn),
    );
    cancelBtn.addEventListener('click', () => dialog.close());
    confirmBtn.addEventListener('click', () => {
      result = true;
      dialog.close();
    });
    dialog.addEventListener('click', (e) => {
      // Click on the backdrop closes.
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    (tone === 'danger' ? cancelBtn : confirmBtn).focus();
  });
}
