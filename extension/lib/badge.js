// Toolbar badge: how many things need the user's attention.

import { STORAGE_KEYS } from './constants.js';
import { serviceStatus } from './status.js';
import { isActive, isUrgent } from './alerts.js';
import { readLocal } from './storage.js';

export const BADGE_COLOR = '#B42318';

/**
 * Services whose derived status is `needs_attention` (an opt-out flipped back
 * or an unacknowledged important policy change), plus unread warning/critical
 * alerts about anything else. A service is never counted twice.
 */
export function computeBadgeCount({ registry, userState, settings, alerts }) {
  const attention = new Set();
  for (const service of registry?.services ?? []) {
    if (serviceStatus(service, userState, settings.region).code === 'needs_attention')
      attention.add(service.id);
  }
  let count = attention.size;
  const counted = new Set();
  for (const a of alerts ?? []) {
    if (!isActive(a) || !isUrgent(a)) continue;
    if (a.serviceId && attention.has(a.serviceId)) continue;
    const key = a.serviceId ? `s:${a.serviceId}` : `a:${a.id}`;
    if (counted.has(key)) continue;
    counted.add(key);
    count += 1;
  }
  return count;
}

export function badgeText(count) {
  if (!count) return '';
  return count > 99 ? '99+' : String(count);
}

/** Recomputes and applies the badge. Never throws. */
export async function updateBadge() {
  const action = globalThis.chrome?.action;
  if (!action?.setBadgeText) return;
  try {
    const state = await readLocal([
      STORAGE_KEYS.registry,
      STORAGE_KEYS.userState,
      STORAGE_KEYS.settings,
      STORAGE_KEYS.alerts,
    ]);
    const count = computeBadgeCount(state);
    await action.setBadgeText({ text: badgeText(count) });
    if (count > 0) {
      await action.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
      await action.setBadgeTextColor?.({ color: '#FFFFFF' });
    }
    const title =
      count === 0 ? 'NoTrain' : `NoTrain: ${count} ${count === 1 ? 'item needs' : 'items need'} attention`;
    await action.setTitle?.({ title });
  } catch (err) {
    console.warn('NoTrain: could not update badge', err);
  }
}
