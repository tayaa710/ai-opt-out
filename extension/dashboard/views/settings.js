// #/settings: region, profile, notifications, checks & updates, site access, your data.

import { api } from '../../lib/api.js';
import { REGIONS } from '../../lib/region.js';
import { h } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { monogram } from '../../shared/monogram.js';
import { confirmDialog } from '../../shared/dialog.js';
import { toast } from '../../shared/toast.js';
import { formatDate, relativeTime, fileStamp, describeOrigin, listJoin } from '../../shared/format.js';
import { REMINDER_OPTIONS } from '../../shared/labels.js';
import { pageHeader, button, act, switchField, selectField, textField, downloadText } from '../common.js';

/** Unsaved text typed into profile fields (survives live re-renders). */
const drafts = {};

/** Cached chrome.permissions.getAll() result. */
const perms = { loaded: false, origins: [], permissions: [], key: '' };

export function title() {
  return 'Settings';
}

async function refreshPermissions(ctx) {
  try {
    const all = await chrome.permissions.getAll();
    const origins = (all.origins ?? []).filter((o) => /^https?:\/\//.test(o)).sort();
    const permissions = all.permissions ?? [];
    const key = JSON.stringify([origins, permissions]);
    const changed = key !== perms.key;
    Object.assign(perms, { loaded: true, origins, permissions, key });
    if (changed) ctx.rerender();
  } catch {
    if (!perms.loaded) {
      perms.loaded = true;
      ctx.rerender();
    }
  }
}

function card(titleText, id, description, ...children) {
  return h(
    'section',
    { class: 'nt-card s-card', 'aria-labelledby': `${id}-title`, id },
    h(
      'div',
      { class: 's-card__head' },
      h('h2', { class: 's-card__title', id: `${id}-title` }, titleText),
      description && h('p', { class: 's-card__desc' }, description),
    ),
    h('div', { class: 's-card__body' }, children),
  );
}

async function save(patch, message) {
  try {
    await api.updateSettings(patch);
    if (message) toast(message);
  } catch (err) {
    toast(`Couldn’t save: ${err.message}`, { tone: 'bad' });
  }
}

function syncStatus(meta) {
  if (!meta) return null;
  const listDate = meta.generatedAt ? formatDate(meta.generatedAt) : null;
  const checked = meta.lastSyncAt ? relativeTime(meta.lastSyncAt) : null;
  let tone = 'good';
  let text;
  if (meta.lastSyncStatus === 'error') {
    tone = 'bad';
    text = `Last check failed${checked ? ` (${checked})` : ''}. NoTrain keeps using the list it has.`;
  } else if (checked) {
    text = `Checked ${checked}.`;
  } else {
    tone = 'neutral';
    text = 'Not checked yet. Using the list that came with NoTrain.';
  }
  return h(
    'div',
    { class: 's-sync', 'data-testid': 'sync-status' },
    h('span', { class: ['s-sync__dot', `s-sync__dot--${tone}`], 'aria-hidden': 'true' }),
    h(
      'div',
      null,
      h('p', { class: 's-sync__main' }, text),
      h(
        'p',
        { class: 'nt-subtle' },
        [listDate && `Service list dated ${listDate}`, meta.source === 'remote' ? 'downloaded' : meta.source === 'bundled' ? 'built in' : null]
          .filter(Boolean)
          .join(', '),
        meta.lastSyncStatus === 'error' && meta.lastError ? ` · ${meta.lastError}` : '',
      ),
    ),
  );
}

function servicesForOrigin(origin, services) {
  return services.filter((s) => (s.optOuts ?? []).some((o) => o.automation?.hostPermissions?.includes(origin)) || (s.detection?.cookies ?? []).some((c) => origin.startsWith(`${new URL(c.url).origin}/`)));
}

function siteAccess(ctx) {
  const services = ctx.state.registry.services;
  if (!perms.loaded) return h('p', { class: 'nt-subtle' }, 'Loading…');
  const rows = perms.origins.map((origin) => {
    const users = servicesForOrigin(origin, services);
    return h(
      'li',
      { class: 's-perm', 'data-testid': 'perm-row' },
      users[0] ? monogram(users[0], { size: 'sm' }) : h('span', { class: 's-perm__globe' }, icon('globe')),
      h(
        'div',
        { class: 's-perm__main' },
        h('span', { class: 's-perm__host nt-mono' }, describeOrigin(origin)),
        users.length > 0 && h('span', { class: 'nt-subtle' }, `Used for ${listJoin(users.map((u) => u.name))}`),
      ),
      button('Revoke', {
        variant: 'danger-ghost',
        size: 'sm',
        testid: 'perm-revoke',
        ariaLabel: `Revoke access to ${describeOrigin(origin)}`,
        onClick: (e) =>
          act(
            e.currentTarget,
            async () => {
              const removed = await chrome.permissions.remove({ origins: [origin] });
              await refreshPermissions(ctx);
              return removed;
            },
            { success: (ok) => (ok ? `Access to ${describeOrigin(origin)} removed` : 'That permission can’t be removed'), failure: 'Couldn’t revoke' },
          ),
      }),
    );
  });
  const cookies = perms.permissions.includes('cookies');
  return [
    rows.length
      ? h('ul', { class: 'nt-list s-perms', role: 'list' }, rows)
      : h(
          'p',
          { class: 's-empty', 'data-testid': 'perm-empty' },
          icon('shieldCheck', { size: 16 }),
          'NoTrain doesn’t have access to any sites. It only asks when you use “Opt out for me”.',
        ),
    cookies &&
      h(
        'div',
        { class: 's-perm s-perm--extra' },
        h('span', { class: 's-perm__globe' }, icon('key')),
        h('div', { class: 's-perm__main' }, h('span', { class: 's-perm__host' }, 'Cookie check'), h('span', { class: 'nt-subtle' }, 'Left over from account detection.')),
        button('Revoke', {
          variant: 'danger-ghost',
          size: 'sm',
          onClick: (e) =>
            act(
              e.currentTarget,
              async () => {
                await chrome.permissions.remove({ permissions: ['cookies'] });
                await refreshPermissions(ctx);
              },
              { success: 'Cookie access removed', failure: 'Couldn’t revoke' },
            ),
        }),
      ),
  ];
}

function importButton(ctx) {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'nt-visually-hidden',
    id: 'import-file',
    tabindex: '-1',
    'aria-hidden': 'true',
    'data-testid': 'import-input',
    onChange: async (e) => {
      const file = e.currentTarget.files?.[0];
      e.currentTarget.value = '';
      if (!file) return;
      let data;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error('File is too large');
        data = JSON.parse(await file.text());
        if (!data || typeof data !== 'object') throw new Error('Not a NoTrain backup');
      } catch (err) {
        toast(`That file can’t be imported: ${err.message}`, { tone: 'bad' });
        return;
      }
      const ok = await confirmDialog({
        title: 'Replace your current setup?',
        body: `Your settings and progress will be replaced with the backup${data.exportedAt ? ` from ${formatDate(data.exportedAt)}` : ''}.`,
        confirmLabel: 'Import backup',
        iconName: 'upload',
      });
      if (!ok) return;
      try {
        await api.importData(data);
        toast('Backup imported');
      } catch (err) {
        toast(`Import failed: ${err.message}`, { tone: 'bad' });
      }
    },
  });
  return [input, button('Import', { variant: 'secondary', iconName: 'upload', testid: 'import-button', onClick: () => input.click() })];
}

export function render(ctx) {
  const { state } = ctx;
  const { settings, registryMeta } = state;
  const n = settings.notifications ?? {};
  refreshPermissions(ctx);

  return [
    pageHeader({ title: 'Settings', subtitle: 'Everything here is stored on this device only.' }),
    h(
      'div',
      { class: 's-grid' },
      card(
        'Region',
        'set-region',
        'Decides which opt-outs apply to you and which laws letters cite.',
        selectField({
          id: 'settings-region',
          label: 'Where you live',
          value: settings.region,
          options: REGIONS.map((r) => ({ value: r.code, label: r.law ? `${r.label} (${r.law})` : r.label })),
          testid: 'settings-region',
          onChange: (e) => save({ region: e.currentTarget.value }, 'Region updated'),
        }),
      ),
      card(
        'Your details',
        'set-profile',
        'Only used to fill in request letters. NoTrain never sends them anywhere.',
        h(
          'div',
          { class: 's-fields' },
          textField({
            id: 'settings-name',
            label: 'Full name',
            value: drafts.fullName ?? settings.profile?.fullName,
            autocomplete: 'name',
            testid: 'settings-name',
            onInput: (e) => {
              drafts.fullName = e.currentTarget.value;
            },
            onChange: async (e) => {
              await save({ profile: { fullName: e.currentTarget.value.trim() } }, 'Name saved');
              delete drafts.fullName;
            },
          }),
          textField({
            id: 'settings-email',
            label: 'Email on your accounts',
            type: 'email',
            value: drafts.email ?? settings.profile?.email,
            autocomplete: 'email',
            testid: 'settings-email',
            onInput: (e) => {
              drafts.email = e.currentTarget.value;
            },
            onChange: async (e) => {
              await save({ profile: { email: e.currentTarget.value.trim() } }, 'Email saved');
              delete drafts.email;
            },
          }),
        ),
      ),
      card(
        'Notifications',
        'set-notify',
        'NoTrain shows a system notification only for things that need you. Everything else waits in Alerts.',
        switchField({
          id: 'notify-policy',
          label: 'Policy changes',
          description: 'When a company starts training on your data or changes its opt-out.',
          checked: n.policyChanges !== false,
          testid: 'notify-policy',
          onChange: (e) => save({ notifications: { policyChanges: e.currentTarget.checked } }),
        }),
        switchField({
          id: 'notify-flip',
          label: 'Settings switched back on',
          description: 'When a setting you turned off is found on again.',
          checked: n.flipBacks !== false,
          testid: 'notify-flip',
          onChange: (e) => save({ notifications: { flipBacks: e.currentTarget.checked } }),
        }),
        switchField({
          id: 'notify-reminders',
          label: 'Re-check reminders',
          description: 'A gentle nudge to confirm your settings are still off.',
          checked: n.reminders !== false,
          testid: 'notify-reminders',
          onChange: (e) => save({ notifications: { reminders: e.currentTarget.checked } }),
        }),
        h(
          'div',
          { class: 's-inline-field' },
          selectField({
            id: 'settings-reminder',
            label: 'Remind me to re-check',
            value: String(settings.reminderIntervalDays ?? 90),
            options: REMINDER_OPTIONS.map((o) => ({ value: String(o.days), label: o.label })),
            testid: 'settings-reminder',
            onChange: (e) => save({ reminderIntervalDays: Number(e.currentTarget.value) }, 'Reminder updated'),
          }),
        ),
      ),
      card(
        'Checks and updates',
        'set-updates',
        null,
        switchField({
          id: 'settings-passive',
          label: 'Check settings when I visit',
          description: 'When you open a service’s settings page, NoTrain quietly confirms the switches you turned off are still off. It never changes anything on its own.',
          checked: settings.passiveChecks !== false,
          testid: 'settings-passive',
          onChange: (e) => save({ passiveChecks: e.currentTarget.checked }),
        }),
        switchField({
          id: 'settings-autosync',
          label: 'Update the service list weekly',
          description: 'Downloads the public list of services and opt-outs, so you hear about policy changes. Nothing about you is sent.',
          checked: settings.autoSync !== false,
          testid: 'settings-autosync',
          onChange: (e) => save({ autoSync: e.currentTarget.checked }),
        }),
        h(
          'div',
          { class: 's-sync-row' },
          syncStatus(registryMeta),
          button('Check for updates now', {
            variant: 'secondary',
            iconName: 'refresh',
            testid: 'sync-now',
            onClick: (e) =>
              act(e.currentTarget, () => api.syncRegistry(true), {
                success: (meta) => (meta?.lastSyncStatus === 'error' ? 'Couldn’t reach the update server' : meta?.lastSyncStatus === 'unchanged' ? 'You already have the latest list' : 'Service list updated'),
                failure: 'Update failed',
              }),
          }),
        ),
      ),
      card(
        'Site access',
        'set-access',
        'Sites NoTrain may open settings on, granted when you chose “Opt out for me”. Revoking just means NoTrain will ask again next time.',
        siteAccess(ctx),
      ),
      card(
        'Your data',
        'set-data',
        'A backup includes your settings, tracked services, progress and alerts.',
        h(
          'div',
          { class: 's-data-row' },
          h('div', null, h('p', { class: 's-row-title' }, 'Back up or move to another browser'), h('p', { class: 'nt-subtle' }, 'Saved as a JSON file on your computer.')),
          h(
            'div',
            { class: 'nt-btn-row' },
            button('Export', {
              variant: 'secondary',
              iconName: 'download',
              testid: 'export-button',
              onClick: (e) =>
                act(
                  e.currentTarget,
                  async () => {
                    const data = await api.exportData();
                    downloadText(`notrain-backup-${fileStamp()}.json`, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
                  },
                  { success: 'Backup downloaded', failure: 'Export failed' },
                ),
            }),
            importButton(ctx),
          ),
        ),
        h(
          'div',
          { class: 's-data-row s-data-row--danger' },
          h('div', null, h('p', { class: 's-row-title' }, 'Start over'), h('p', { class: 'nt-subtle' }, 'Erases your settings, tracked services, progress and alerts from this browser.')),
          button('Reset NoTrain', {
            variant: 'danger-ghost',
            iconName: 'trash',
            testid: 'reset-button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Reset NoTrain?',
                body: 'This erases your settings, tracked services, progress and alerts. Settings you already changed on other sites stay changed. This can’t be undone.',
                confirmLabel: 'Erase everything',
                tone: 'danger',
              });
              if (!ok) return;
              try {
                await api.resetAll();
                toast('NoTrain has been reset');
                ctx.navigate('#/welcome');
              } catch (err) {
                toast(`Reset failed: ${err.message}`, { tone: 'bad' });
              }
            },
          }),
        ),
      ),
    ),
  ];
}
