// Activity history: an append-only (newest first), capped log of what happened
// to each opt-out. Stored locally only.

import { HISTORY_LIMIT } from './constants.js';
import { newId } from './storage.js';

export const HISTORY_ACTIONS = Object.freeze(['auto', 'guided', 'manual', 'letter', 'verify', 'passive']);
export const DETAIL_MAX = 300;

/**
 * @param {{ serviceId: string, optOutId: string, action: string, outcome: string, detail?: string }} fields
 * @param {Date} [now]
 */
export function makeHistoryEntry({ serviceId, optOutId, action, outcome, detail }, now = new Date()) {
  const entry = { id: newId(), at: now.toISOString(), serviceId, optOutId, action, outcome };
  if (typeof detail === 'string' && detail.trim() !== '') entry.detail = detail.trim().slice(0, DETAIL_MAX);
  return entry;
}

/** Prepends entries (given oldest → newest or single) and caps the list. */
export function appendHistory(history, entries, limit = HISTORY_LIMIT) {
  const list = Array.isArray(history) ? history : [];
  const add = Array.isArray(entries) ? entries : [entries];
  return [...add.slice().reverse(), ...list].slice(0, limit);
}
