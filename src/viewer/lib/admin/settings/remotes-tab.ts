// Settings › Remotes tab (followed remote nodes): subscribe to an issuer link, sync, appropriate
// (detached editable copy) or unsubscribe. Also owns the two doc-level buttons (btn-node-appropriate
// / btn-node-remove) that act on the currently-open mirror doc.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { currentFile } from '../../core/state';
import { setStatus } from '../../core/net';
import { Dialogs } from '../../modals/dialogs';
import { refreshTreeOrReload } from '../../modals/new-file-modal';
import { homeView } from '../../home/home-view';
import { SettingsContext, remoteNodeInfo, shareFormatDate } from './settings-shared';

export class SettingsRemotes {
  private readonly list = document.getElementById('settings-remotes-list')!;
  private readonly form = document.getElementById('settings-remote-form') as HTMLFormElement;

  constructor(private readonly ctx: SettingsContext) {
    document.getElementById('btn-node-appropriate')!.addEventListener('click', () => this.appropriateFromDoc());
    document.getElementById('btn-node-remove')!.addEventListener('click', () => this.removeFromDoc());
    this.form.addEventListener('submit', (e) => this.submit(e));
    this.list.addEventListener('click', (e) => this.onClick(e));
  }

  async load(): Promise<void> {
    this.list.innerHTML = '';

    try {
      const remotes = await this.ctx.fetch<any[]>('/api/admin/remotes');

      if (!Array.isArray(remotes) || remotes.length === 0) {
        this.list.innerHTML =
          '<li class="text-sm text-ink-500">' + t('settingsNoRemotes') + '</li>';

        return;
      }

      this.list.innerHTML = remotes
        .map((r) => {
          const nameEsc = escapeHtml(r.name || '');
          const pathEsc = escapeHtml(r.path || '');
          const synced = r.last_sync_at
            ? t('settingsRemoteSynced', shareFormatDate(r.last_sync_at))
            : t('settingsRemoteNeverSynced');
          const originHost = (r.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          const originLine = originHost
            ? '<div class="text-xs text-sky-300/70 mt-0.5 truncate" title="' +
              escapeHtml(r.url || '') +
              '">' +
              escapeHtml(t('settingsRemoteFrom', originHost)) +
              '</div>'
            : '';
          const errLine = r.last_error
            ? '<div class="text-rose-400 text-xs mt-0.5 truncate" title="' +
              escapeHtml(r.last_error) +
              '">' +
              escapeHtml(t('settingsRemoteError', r.last_error)) +
              '</div>'
            : '';

          return (
            '<li class="admin-row bg-navy-900 border subtle-border rounded p-3 text-sm">' +
            '<div class="flex-1 min-w-0">' +
            '<div class="text-ink-100 font-medium font-mono truncate" title="' +
            nameEsc +
            '">' +
            nameEsc +
            '</div>' +
            '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
            pathEsc +
            '">' +
            pathEsc +
            '</div>' +
            originLine +
            '<div class="text-ink-500 text-xs mt-0.5">' +
            escapeHtml(synced) +
            '</div>' +
            errLine +
            '</div>' +
            '<div class="admin-row__actions">' +
            '<button class="settings-remote-sync px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
            nameEsc +
            '">' +
            t('settingsRemoteSync') +
            '</button>' +
            '<button class="settings-remote-appropriate px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
            nameEsc +
            '" title="' +
            escapeHtml(t('settingsRemoteAppropriateTitle')) +
            '">' +
            t('settingsRemoteAppropriate') +
            '</button>' +
            '<button class="settings-remote-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
            nameEsc +
            '">' +
            t('settingsRemoteRemove') +
            '</button>' +
            '</div>' +
            '</li>'
          );
        })
        .join('');
    } catch (e) {
      this.ctx.showError((e as Error).message);
    }
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const input = document.getElementById('settings-remote-link') as HTMLInputElement;
    const link = input.value.trim();

    if (!link) return;

    try {
      const res = await this.ctx.fetch<any>('/api/admin/remotes', {
        method: 'POST',
        body: JSON.stringify({ link }),
      });

      input.value = '';

      // Issuer unreachable: sync fails but the subscription is created — report without blocking
      // (the periodic sync retries).
      if (res && res.sync && res.sync.ok === false) {
        this.ctx.showError(t('settingsRemoteSyncFailed', res.sync.error || ''));
      }

      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }

  private async onClick(e: Event): Promise<void> {
    const syncBtn = this.ctx.hit(e, '.settings-remote-sync');

    if (syncBtn) {
      (syncBtn as HTMLButtonElement).disabled = true;

      try {
        const res = await this.ctx.fetch<any>('/api/admin/remotes/sync', {
          method: 'POST',
          body: JSON.stringify({ name: syncBtn.dataset.name }),
        });
        const r = res && res.results ? res.results[syncBtn.dataset.name!] : null;

        if (r && r.ok === false) this.ctx.showError(t('settingsRemoteSyncFailed', r.error || ''));
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }

      this.load();

      return;
    }

    const apprBtn = this.ctx.hit(e, '.settings-remote-appropriate');

    if (apprBtn) {
      const name = apprBtn.dataset.name;
      // Free-form destination via modal. Default = node name, at the root of your documents.
      const dest = await Dialogs.prompt({
        title: t('settingsRemoteAppropriate'),
        message: t('settingsRemoteAppropriatePrompt', name),
        value: name,
        placeholder: t('appropriateDestPlaceholder'),
        confirmLabel: t('settingsRemoteAppropriate'),
      });

      if (!dest) return;

      try {
        const res = await this.ctx.fetch<any>('/api/admin/remotes/appropriate', {
          method: 'POST',
          body: JSON.stringify({ name, source: '', dest }),
        });

        this.ctx.showError(t('settingsRemoteAppropriated', String(res.copied || 0)));
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }

      return;
    }

    const delBtn = this.ctx.hit(e, '.settings-remote-del');

    if (!delBtn || !delBtn.dataset.name) return;
    const ok = await Dialogs.confirm({
      title: t('settingsRemoteRemoveTitle'),
      message: t('settingsRemoteRemoveMsg', delBtn.dataset.name),
      confirmLabel: t('settingsRemoteRemove'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await this.ctx.fetch('/api/admin/remotes', {
        method: 'DELETE',
        body: JSON.stringify({ name: delBtn.dataset.name }),
      });
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }

  // Appropriate from a mirror doc: node's only file → whole node, otherwise just that file.
  // Produces a detached, editable copy in your documents.
  private async appropriateFromDoc(): Promise<void> {
    const file = currentFile;

    if (!file) return;
    const info = remoteNodeInfo(file.path);

    if (!info) return;
    const whole = info.fileCount <= 1;
    const dest = await Dialogs.prompt({
      title: t('nodeAppropriateBtn'),
      message: whole
        ? t('nodeAppropriateWholePrompt', info.name)
        : t('nodeAppropriateFilePrompt', file.name),
      value: whole ? info.name : file.name || '',
      confirmLabel: t('nodeAppropriateBtn'),
    });

    if (!dest) return;

    try {
      const res = await this.ctx.fetch<any>('/api/admin/remotes/appropriate', {
        method: 'POST',
        body: JSON.stringify({ name: info.name, source: whole ? '' : info.sourceRel, dest }),
      });

      setStatus(t('settingsRemoteAppropriated', String(res.copied || 0)), 'ok');
      await refreshTreeOrReload();
    } catch (e) {
      setStatus(t('err', (e as Error).message), 'err');
    }
  }

  // Remove from a mirror doc = unsubscribe entirely: a single removed file would just come back on
  // the next sync, so we drop the whole subscription.
  private async removeFromDoc(): Promise<void> {
    const file = currentFile;

    if (!file) return;
    const info = remoteNodeInfo(file.path);

    if (!info) return;
    const ok = await Dialogs.confirm({
      title: t('nodeRemoveTitle'),
      message: t('settingsRemoteRemoveMsg', info.name),
      confirmLabel: t('settingsRemoteRemove'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await this.ctx.fetch('/api/admin/remotes', {
        method: 'DELETE',
        body: JSON.stringify({ name: info.name }),
      });
      homeView.showWelcome();
      await refreshTreeOrReload();
    } catch (e) {
      setStatus(t('err', (e as Error).message), 'err');
    }
  }
}
