// Settings › Users tab: list the accounts, invite a new one (one-time link), resend a pending
// invite, reset a password, or delete. All mutations go through the shared SettingsContext.

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { avatarSeed, constellationSvg } from '../../ui/avatar';
import { Dialogs } from '../../modals/dialogs';
import { resetPwModal } from '../../modals/reset-password';
import { SettingsContext } from './settings-shared';

export class SettingsUsers {
  private readonly list = document.getElementById('settings-users-list')!;
  private readonly form = document.getElementById('settings-user-form') as HTMLFormElement;
  private readonly inviteResult = document.getElementById('settings-invite-result')!;

  constructor(private readonly ctx: SettingsContext) {
    this.form.addEventListener('submit', (e) => this.submit(e));
    this.list.addEventListener('click', (e) => this.onClick(e));
    document.getElementById('settings-invite-copy')!.addEventListener('click', (e) =>
      this.ctx.copyFromInput(e.currentTarget as HTMLElement, 'settings-invite-link'),
    );
    document.getElementById('settings-invite-close')!.addEventListener('click', () => this.hideInviteResult());
  }

  async load(): Promise<void> {
    this.list.innerHTML = '';

    try {
      const users = await this.ctx.fetch<any[]>('/api/admin/users');

      if (!Array.isArray(users) || users.length === 0) {
        this.list.innerHTML =
          '<li class="text-sm text-ink-500">' + t('settingsNoUsers') + '</li>';

        return;
      }

      this.list.innerHTML = users
        .map((u) => {
          const roleLabel = u.role === 'admin' ? t('settingsRoleAdmin') : t('settingsRoleViewer');
          const roleCls = u.role === 'admin' ? 'text-accent' : 'text-ink-400';
          const emailEsc = escapeHtml(u.email);
          const fullName = [u.first_name, u.last_name].map((p: any) => (p || '').trim()).filter(Boolean).join(' ');
          const nameLine = fullName
            ? '<div class="text-ink-100 font-medium truncate" title="' +
              escapeHtml(fullName) +
              '">' +
              escapeHtml(fullName) +
              '</div>'
            : '';
          // A pending account was invited but hasn't set a password yet: show a badge, and offer
          // "resend invite" instead of "reset password" (which 404s on a pending account — the
          // password is set via the invite link).
          const pendingBadge = u.pending
            ? ' <span class="settings-pending-badge">' +
              escapeHtml(t('settingsInvitePending')) +
              '</span>'
            : '';
          const actionBtn = u.pending
            ? '<button class="settings-user-resend px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' +
              emailEsc +
              '" data-role="' +
              escapeHtml(u.role || '') +
              '">' +
              escapeHtml(t('settingsResendInvite')) +
              '</button>'
            : '<button class="settings-user-reset px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-email="' +
              emailEsc +
              '" title="' +
              escapeHtml(t('settingsResetPassword')) +
              '">' +
              escapeHtml(t('settingsResetPasswordShort')) +
              '</button>';
          return (
            '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
            '<div class="admin-row">' +
            '<div class="flex-shrink-0 mr-2.5">' + constellationSvg(avatarSeed(u.first_name, u.last_name, u.email), 28) + '</div>' +
            '<div class="flex-1 min-w-0">' +
            nameLine +
            '<div class="' +
            (fullName ? 'text-ink-400 text-xs' : 'text-ink-100 font-medium') +
            ' truncate" title="' +
            emailEsc +
            '">' +
            emailEsc +
            '</div>' +
            '<div class="' +
            roleCls +
            ' text-xs uppercase tracking-wider font-semibold mt-0.5">' +
            escapeHtml(roleLabel) +
            pendingBadge +
            '</div>' +
            '</div>' +
            '<div class="admin-row__actions">' +
            actionBtn +
            '<button class="settings-user-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-email="' +
            emailEsc +
            '" data-role="' +
            escapeHtml(u.role || '') +
            '">' +
            t('settingsDeleteUser') +
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

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.ctx.clearError();
    const email = (document.getElementById('settings-user-email') as HTMLInputElement).value.trim();
    const role = (document.getElementById('settings-user-role') as HTMLInputElement).value;

    try {
      const data = await this.ctx.fetch<any>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      // One-time display: the invite link is returned once and never again.
      this.showInviteResult(data.invite_url);
      this.form.reset();
      this.load();
    } catch (err) {
      this.ctx.showError((err as Error).message);
    }
  }

  private async onClick(e: Event): Promise<void> {
    const resendBtn = this.ctx.hit(e, '.settings-user-resend');

    if (resendBtn) {
      try {
        const data = await this.ctx.fetch<any>('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({ email: resendBtn.dataset.email, role: resendBtn.dataset.role }),
        });
        this.showInviteResult(data.invite_url);
        this.load();
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }

      return;
    }

    const resetBtn = this.ctx.hit(e, '.settings-user-reset');

    if (resetBtn) {
      resetPwModal.open(resetBtn.dataset.email);

      return;
    }

    const delBtn = this.ctx.hit(e, '.settings-user-del');

    if (delBtn) {
      const ok = await Dialogs.confirm({
        title: t('settingsDeleteUserTitle'),
        message: t('settingsDeleteUserMsg', delBtn.dataset.email),
        confirmLabel: t('settingsDeleteUser'),
        destructive: true,
      });

      if (!ok) return;

      try {
        await this.ctx.fetch('/api/admin/users', {
          method: 'DELETE',
          body: JSON.stringify({ email: delBtn.dataset.email }),
        });
        this.load();
      } catch (err) {
        this.ctx.showError((err as Error).message);
      }
    }
  }

  // ── Invite link one-time display (mirror of the token result) ──
  private showInviteResult(url: string): void {
    if (!url) return;
    (document.getElementById('settings-invite-link') as HTMLInputElement).value = url;
    this.inviteResult.classList.remove('hidden');
  }

  private hideInviteResult(): void {
    this.inviteResult.classList.add('hidden');
    (document.getElementById('settings-invite-link') as HTMLInputElement).value = '';
  }
}
