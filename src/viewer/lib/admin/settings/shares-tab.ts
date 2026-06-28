// Settings › Shares tab: list the public share links, copy/reactivate (re-point a broken one) or
// revoke them.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { Dialogs } from '../../modals/dialogs';
import { SettingsContext, shareFormatDate } from './settings-shared';

export class SettingsShares {
  private readonly list = document.getElementById('settings-shares-list')!;

  constructor(private readonly ctx: SettingsContext) {
    this.list.addEventListener('click', (e) => this.onClick(e));
  }

  async load(): Promise<void> {
    this.list.innerHTML = '';

    try {
      const shares = await this.ctx.fetch<any[]>('/api/share/list');

      if (!Array.isArray(shares) || shares.length === 0) {
        this.list.innerHTML =
          '<li class="text-sm text-ink-500">' + t('settingsNoShares') + '</li>';

        return;
      }

      this.list.innerHTML = shares
        .map((item) => {
          const exp = item.expires_at
            ? t('expiresShort', shareFormatDate(item.expires_at))
            : t('noExpiry');
          const created = item.created_at ? t('createdShort', shareFormatDate(item.created_at)) : '';
          const pathEsc = escapeHtml(item.path || '');
          const broken = item.file_exists === false;
          const url = item.token ? location.origin + '/s/' + item.token : '';
          const urlEsc = escapeHtml(url);
          const urlLine = url
            ? '<div class="text-ink-300 font-mono text-xs truncate mt-0.5" title="' +
              urlEsc +
              '">' +
              urlEsc +
              '</div>'
            : '';
          const copyBtn = url
            ? '<button class="settings-share-copy px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' +
              urlEsc +
              '" title="' +
              escapeHtml(t('copy')) +
              '">' +
              t('copy') +
              '</button>'
            : '';

          return (
            '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
            '<div class="flex-1 min-w-0">' +
            '<div class="text-ink-100 font-medium truncate" title="' +
            pathEsc +
            '">' +
            pathEsc +
            (broken
              ? ' <span class="text-rose-300 text-xs font-normal">' + t('shareBroken') + '</span>'
              : '') +
            '</div>' +
            urlLine +
            '<div class="text-ink-500 text-xs mt-0.5">' +
            escapeHtml(created) +
            ' &middot; ' +
            escapeHtml(exp) +
            '</div>' +
            '</div>' +
            '<div class="admin-row__actions">' +
            copyBtn +
            (broken
              ? '<button class="settings-share-reactivate px-3 py-1.5 text-sm bg-navy-700 hover:bg-emerald-500/30 hover:text-emerald-300 text-ink-200 rounded" data-id="' +
                escapeHtml(item.id || '') +
                '" data-path="' +
                pathEsc +
                '" data-suggested="' +
                escapeHtml(item.suggested_path || '') +
                '">' +
                t('shareReactivate') +
                '</button>'
              : '') +
            '<button class="settings-share-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
            escapeHtml(item.id || '') +
            '">' +
            t('revoke') +
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

  private async onClick(e: Event): Promise<void> {
    const copyBtn = this.ctx.hit(e, '.settings-share-copy');

    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.url || '');
        copyBtn.textContent = t('copied');
        setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
      } catch (_) {}

      return;
    }

    const reactivateBtn = this.ctx.hit(e, '.settings-share-reactivate');

    if (reactivateBtn) {
      // Doc moved/disappeared: point the link at its new path (URL stays the same).
      const newPath = await Dialogs.prompt({
        title: t('shareReactivateTitle'),
        message: t('shareReactivateMsg', reactivateBtn.dataset.path || ''),
        value: reactivateBtn.dataset.suggested || '',
        placeholder: t('shareReactivatePlaceholder'),
        confirmLabel: t('shareReactivate'),
      });

      if (!newPath) return;

      try {
        await this.ctx.fetch('/api/share/' + reactivateBtn.dataset.id, {
          method: 'PATCH',
          body: JSON.stringify({ path: newPath.trim() }),
        });
        this.load();
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }

      return;
    }

    const revokeBtn = this.ctx.hit(e, '.settings-share-revoke');

    if (!revokeBtn || !revokeBtn.dataset.id) return;
    const ok = await Dialogs.confirm({
      title: t('revokeConfirmTitle'),
      message: t('revokeConfirmMsg'),
      confirmLabel: t('revoke'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await this.ctx.fetch('/api/share/' + revokeBtn.dataset.id, { method: 'DELETE' });
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }
}
