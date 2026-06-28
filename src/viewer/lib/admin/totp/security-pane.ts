// The Settings → Security pane: the 2FA status badge, the enable / disable buttons and "sign out all
// sessions". State only — the enrollment / verify / disable UI lives in the modal (./totp-enroll-modal),
// which the enable and disable buttons open. refreshState reflects the totpEnabled flag (owned
// by core/data-csrf.ts) and is called by the Settings Security tab (admin/settings/settings-panel.ts)
// and boot/bootstrap.ts (/api/me boot). Mutating requests go through settingsFetch
// (../settings/settings-shared). totpModal is imported from ./totp-enroll-modal, so it is available when
// the enable / disable buttons are wired below.

import { totpEnabled } from '../../core/data-csrf';
import { t } from '../../core/i18n';
import { Dialogs } from '../../modals/dialogs';
import { settingsFetch } from '../settings/settings-shared';
import { settingsPanel } from '../settings/settings-panel';
import { totpModal } from './totp-enroll-modal';

export class SecurityPane {
  private readonly statusBadge = document.getElementById('security-totp-status')!;
  private readonly enableBtn = document.getElementById('security-totp-enable') as HTMLButtonElement;
  private readonly disableBtn = document.getElementById('security-totp-disable') as HTMLButtonElement;
  private readonly logoutAllBtn = document.getElementById('security-logout-all') as HTMLButtonElement;

  constructor() {
    this.wire();
  }

  // totpEnabled is updated by /api/me and by the enable/disable actions.
  refreshState(): void {
    this.statusBadge.textContent = totpEnabled ? t('securityTotpStatusOn') : t('securityTotpStatusOff');
    this.statusBadge.classList.toggle('bg-emerald-500/20', totpEnabled);
    this.statusBadge.classList.toggle('text-emerald-300', totpEnabled);
    this.statusBadge.classList.toggle('bg-ink-500/15', !totpEnabled);
    this.statusBadge.classList.toggle('text-ink-400', !totpEnabled);
    this.enableBtn.classList.toggle('hidden', totpEnabled);
    this.disableBtn.classList.toggle('hidden', !totpEnabled);
  }

  // The enable button stays disabled for the whole init round-trip (no double-submit); the modal owns
  // the enrollment flow itself.
  private async enable(): Promise<void> {
    this.enableBtn.disabled = true;

    try {
      await totpModal.enroll();
    } finally {
      this.enableBtn.disabled = false;
    }
  }

  // ---- log out all my sessions: in-app confirmation then redirect to /login ----
  private async logoutAll(): Promise<void> {
    const ok = await Dialogs.confirm({
      title: t('securityLogoutAllConfirmTitle'),
      message: t('securityLogoutAllConfirmMsg'),
      confirmLabel: t('securityLogoutAllConfirm'),
      destructive: true,
    });

    if (!ok) return;
    this.logoutAllBtn.disabled = true;

    try {
      await settingsFetch('/api/account/logout-all', { method: 'POST', body: JSON.stringify({}) });
      // Epoch changed: the current session is revoked (cookie cleared server-side) → /login.
      window.location.href = '/login';
    } catch (err) {
      settingsPanel.showError((err as Error).message || t('settingsErrGeneric'));
      this.logoutAllBtn.disabled = false;
    }
  }

  private wire(): void {
    this.enableBtn.addEventListener('click', () => this.enable());
    this.disableBtn.addEventListener('click', () => totpModal.openDisable());
    this.logoutAllBtn.addEventListener('click', () => this.logoutAll());
  }
}

export const securityPane = new SecurityPane();
