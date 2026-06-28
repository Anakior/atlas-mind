// Settings › Groups tab (principals group:<name>): list groups, create/edit a group (name + a chips
// combobox of members), delete. The node-path combobox (Nodes tab) is mounted here too — a static
// inputs-once wiring kept verbatim from the original wireGroups (see flag in the A3 report).

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { AtlasCombobox } from '../../ui/combobox';
import { getAllDirs } from '../../modals/new-file-modal';
import { Dialogs } from '../../modals/dialogs';
import { SettingsContext } from './settings-shared';

export class SettingsGroups {
  constructor(private readonly ctx: SettingsContext) {
    this.wire();
  }

  async load(): Promise<void> {
    const list = document.getElementById('settings-groups-list');

    if (!list) return;
    list.innerHTML = '';

    try {
      const groups = await this.ctx.fetch<Record<string, string[]>>('/api/admin/groups'); // { name: [emails] }
      const names = Object.keys(groups || {}).sort();

      if (!names.length) {
        list.innerHTML = '<li class="text-sm text-ink-500">' + t('settingsNoGroups') + '</li>';

        return;
      }

      list.innerHTML = names
        .map((name) => {
          const members = groups[name] || [];
          const nameEsc = escapeHtml(name);
          const membersEsc = escapeHtml(members.join(', '));

          return (
            '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
            '<div class="admin-row">' +
            '<div class="flex-1 min-w-0">' +
            '<div class="text-ink-100 font-medium font-mono truncate">' +
            nameEsc +
            '</div>' +
            '<div class="text-ink-400 text-xs mt-0.5 truncate" title="' +
            membersEsc +
            '">' +
            (members.length
              ? membersEsc
              : '<span class="text-ink-500">' + t('settingsGroupEmpty') + '</span>') +
            '</div>' +
            '</div>' +
            '<div class="admin-row__actions">' +
            '<button class="settings-group-edit px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
            nameEsc +
            '" data-members="' +
            membersEsc +
            '">' +
            t('settingsGroupEdit') +
            '</button>' +
            '<button class="settings-group-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
            nameEsc +
            '">' +
            t('settingsGroupDelete') +
            '</button>' +
            '</div>' +
            '</div>' +
            '</li>'
          );
        })
        .join('');
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  // Node path = a creatable combobox over the mind's existing folders; members = a creatable
  // multi/chips combobox (pick known accounts via /api/directory or type a new email). Both mount
  // once on static inputs that never leave the DOM, so no per-render teardown is needed.
  private wire(): void {
    const nodePathEl = document.getElementById('settings-node-path');

    if (nodePathEl) AtlasCombobox(nodePathEl, { source: getAllDirs, creatable: true });

    const groupForm = document.getElementById('settings-group-form') as HTMLFormElement | null;

    if (!groupForm) return;
    const membersCb = AtlasCombobox(document.getElementById('settings-group-members')!, {
      source: async () => {
        try {
          const r = await fetch('/api/directory');
          return r.ok ? (await r.json()).users || [] : [];
        } catch (_) {
          return [];
        }
      },
      creatable: true,
      multi: true,
      separator: ',',
    });

    groupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.ctx.clearError();
      const name = (document.getElementById('settings-group-name') as HTMLInputElement).value.trim();
      const members = membersCb.getValue();

      try {
        await this.ctx.fetch('/api/admin/groups', {
          method: 'POST',
          body: JSON.stringify({ name, members }),
        });
        groupForm.reset();
        membersCb.clear();
        this.load();
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }
    });

    document.getElementById('settings-groups-list')!.addEventListener('click', async (e) => {
      const editBtn = this.ctx.hit(e, '.settings-group-edit');

      if (editBtn) {
        (document.getElementById('settings-group-name') as HTMLInputElement).value = editBtn.dataset.name || '';
        membersCb.setValue(editBtn.dataset.members || '');
        (document.getElementById('settings-group-name') as HTMLInputElement).focus();

        return;
      }

      const delBtn = this.ctx.hit(e, '.settings-group-del');

      if (delBtn) {
        const ok = await Dialogs.confirm({
          title: t('settingsGroupDeleteTitle'),
          message: t('settingsGroupDeleteMsg', delBtn.dataset.name),
          confirmLabel: t('settingsGroupDelete'),
          destructive: true,
        });

        if (!ok) return;

        try {
          await this.ctx.fetch('/api/admin/groups', {
            method: 'DELETE',
            body: JSON.stringify({ name: delBtn.dataset.name }),
          });
          this.load();
        } catch (err) {
          this.ctx.showError((err as Error).message);
        }
      }
    });
  }
}
