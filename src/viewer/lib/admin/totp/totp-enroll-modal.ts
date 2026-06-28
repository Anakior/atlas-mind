// The 2FA enrollment modal (partials/06-totp.html): the QR + copyable secret + one-time recovery
// codes shown to enable, and the code prompt to disable. The Security pane (18-totp-pane.ts) opens it;
// on a successful enable/disable it flips the global totpEnabled flag (owned by 00-data-csrf.ts),
// reloads the CSRF token (the epoch bump rotates the session cookie) and calls refreshSecurityState()
// so the pane redraws. Concatenates before 18-totp-pane.ts (filename order) so totpModal exists when
// the pane wires its enable/disable buttons. The QR codec AND its canvas bridge are both 17-qr.ts (the
// QrCode class + renderQrCanvas); enroll() calls renderQrCanvas to paint the otpauth URI. The mutating
// requests go through settingsFetch (16-settings.ts).

import { readCsrfCookie, setCsrfToken, setTotpEnabled } from '../../core/data-csrf';
import { t } from '../../core/i18n';
import { setStatus } from '../../core/net';
import { escapeHtml } from '../../core/utils';
import { renderQrCanvas } from '../../ui/qr-code';
import { settingsFetch } from '../settings/settings-shared';
import { settingsPanel } from '../settings/settings-panel';
import { securityPane } from './security-pane';

export class TotpEnrollModal {
  private static readonly SIX_DIGITS = /^[0-9]{6}$/; // a 6-digit code is a TOTP, anything else a recovery code

  private readonly backdrop = document.getElementById('totp-backdrop')!;
  private readonly modalTitle = document.getElementById('totp-title')!;
  private readonly errorBox = document.getElementById('totp-error')!;
  private readonly closeBtn = document.getElementById('totp-close')!;
  private readonly stepEnroll = document.getElementById('totp-step-enroll')!;
  private readonly stepRecovery = document.getElementById('totp-step-recovery')!;
  private readonly stepDisable = document.getElementById('totp-step-disable')!;
  private readonly qr = document.getElementById('totp-qr')!;
  private readonly secretValue = document.getElementById('totp-secret-value') as HTMLInputElement;
  private readonly secretCopy = document.getElementById('totp-secret-copy')!;
  private readonly verifyForm = document.getElementById('totp-verify-form') as HTMLFormElement;
  private readonly verifyCode = document.getElementById('totp-verify-code') as HTMLInputElement;
  private readonly verifySubmit = document.getElementById('totp-verify-submit') as HTMLButtonElement;
  private readonly enrollCancel = document.getElementById('totp-enroll-cancel')!;
  private readonly recoveryList = document.getElementById('totp-recovery-list')!;
  private readonly recoveryCopy = document.getElementById('totp-recovery-copy')!;
  private readonly recoveryDone = document.getElementById('totp-recovery-done')!;
  private readonly disableForm = document.getElementById('totp-disable-form') as HTMLFormElement;
  private readonly disableCode = document.getElementById('totp-disable-code') as HTMLInputElement;
  private readonly disableSubmit = document.getElementById('totp-disable-submit') as HTMLButtonElement;

  // ---- state ----
  private recoveryCodes: string[] = []; // shown ONCE after enable, held only until the modal closes
  // Escape handler bound once: added in the CAPTURE phase so it closes only this modal, and removed
  // by the same reference on close.
  private readonly keyHandler = (e: KeyboardEvent): void => this.onKey(e);

  constructor() {
    this.wire();
  }

  // ---- modal open / close ----
  private openModal(mode: 'enroll' | 'disable'): void {
    this.clearError();
    this.stepEnroll.classList.toggle('hidden', mode !== 'enroll');
    this.stepRecovery.classList.add('hidden');
    this.stepDisable.classList.toggle('hidden', mode !== 'disable');
    this.modalTitle.textContent = mode === 'disable' ? t('totpModalDisableTitle') : t('totpModalTitle');
    this.backdrop.classList.remove('hidden');
    document.addEventListener('keydown', this.keyHandler, true);
  }

  private closeModal(): void {
    this.backdrop.classList.add('hidden');
    document.removeEventListener('keydown', this.keyHandler, true);
    this.recoveryCodes = [];
  }

  // Capture + stopPropagation so Escape closes only the 2FA modal, never the Settings panel
  // underneath. While the recovery codes are shown, Escape is blocked (explicit "Done" required).
  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (this.stepRecovery.classList.contains('hidden')) this.closeModal();
  }

  private showError(msg: string): void {
    this.errorBox.textContent = msg;
    this.errorBox.classList.remove('hidden');
  }

  private clearError(): void {
    this.errorBox.classList.add('hidden');
    this.errorBox.textContent = '';
  }

  // ---- enable: init (secret + URI) → show QR + secret → verification ----
  // The Security pane keeps its enable button disabled for the round-trip; this owns only the flow.
  async enroll(): Promise<void> {
    try {
      const data = await settingsFetch<{ secret?: string; otpauth_uri?: string }>('/api/account/totp/init', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      this.secretValue.value = data.secret || '';
      this.verifyCode.value = '';
      // QR rendered client-side; silent fallback to the plaintext secret if the URI is too long for
      // our encoder.
      this.qr.innerHTML = '';
      const ok = !!data.otpauth_uri && renderQrCanvas(this.qr, data.otpauth_uri, 184);

      this.qr.classList.toggle('hidden', !ok);
      this.openModal('enroll');
      setTimeout(() => this.verifyCode.focus(), 60);
    } catch (err) {
      settingsPanel.showError((err as Error).message || t('settingsErrGeneric'));
    }
  }

  private async verifyEnable(e: Event): Promise<void> {
    e.preventDefault();
    this.clearError();
    const code = this.verifyCode.value.trim();

    if (!code) {
      this.showError(t('totpCodeRequired'));

      return;
    }

    this.verifySubmit.disabled = true;

    try {
      const data = await settingsFetch<{ recovery_codes?: string[] }>('/api/account/totp/enable', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });

      // enable bumps the epoch → fresh session + kb_csrf cookies; reload the CSRF token so the next
      // mutating requests don't break.
      setCsrfToken(readCsrfCookie());
      setTotpEnabled(true);
      securityPane.refreshState();
      // Recovery codes are shown ONCE.
      this.recoveryCodes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
      this.recoveryList.innerHTML = this.recoveryCodes
        .map(
          (c) =>
            '<li class="bg-black/40 border subtle-border rounded px-2 py-1.5 text-center select-all">' +
            escapeHtml(c) +
            '</li>',
        )
        .join('');
      this.stepEnroll.classList.add('hidden');
      this.stepRecovery.classList.remove('hidden');
      setStatus(t('totpEnabledToast'), 'ok');
    } catch (err) {
      const fail = err as { status?: number; message?: string };

      this.showError(fail.status === 400 ? t('totpInvalidCode') : fail.message || t('settingsErrGeneric'));
    } finally {
      this.verifySubmit.disabled = false;
    }
  }

  private async copySecret(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.secretValue.value);
      this.secretCopy.textContent = t('copied');
      setTimeout(() => (this.secretCopy.textContent = t('copy')), 1200);
    } catch (e) {
      this.secretValue.select();
    }
  }

  private async copyRecovery(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.recoveryCodes.join('\n'));
      this.recoveryCopy.textContent = t('copied');
      setTimeout(() => (this.recoveryCopy.textContent = t('totpRecoveryCopy')), 1200);
    } catch (e) {}
  }

  // ---- disable: asks for a code (TOTP or recovery) ----
  openDisable(): void {
    this.disableCode.value = '';
    this.openModal('disable');
    setTimeout(() => this.disableCode.focus(), 60);
  }

  private async disable(e: Event): Promise<void> {
    e.preventDefault();
    this.clearError();
    const code = this.disableCode.value.trim();

    if (!code) {
      this.showError(t('totpCodeRequired'));

      return;
    }

    this.disableSubmit.disabled = true;

    try {
      const body = TotpEnrollModal.SIX_DIGITS.test(code) ? { code } : { recovery: code };

      await settingsFetch('/api/account/totp/disable', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCsrfToken(readCsrfCookie());
      setTotpEnabled(false);
      securityPane.refreshState();
      this.closeModal();
      setStatus(t('totpDisabledToast'), 'ok');
    } catch (err) {
      const fail = err as { status?: number; message?: string };

      this.showError(fail.status === 400 ? t('totpInvalidCode') : fail.message || t('settingsErrGeneric'));
    } finally {
      this.disableSubmit.disabled = false;
    }
  }

  private wire(): void {
    this.verifyForm.addEventListener('submit', (e) => this.verifyEnable(e));
    this.secretCopy.addEventListener('click', () => this.copySecret());
    this.recoveryCopy.addEventListener('click', () => this.copyRecovery());
    this.enrollCancel.addEventListener('click', () => this.closeModal());
    this.recoveryDone.addEventListener('click', () => this.closeModal());
    // X and backdrop close, but never while the one-time recovery codes are on screen.
    this.closeBtn.addEventListener('click', () => {
      if (this.stepRecovery.classList.contains('hidden')) this.closeModal();
    });
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && this.stepRecovery.classList.contains('hidden')) this.closeModal();
    });
    this.disableForm.addEventListener('submit', (e) => this.disable(e));
  }
}

export const totpModal = new TotpEnrollModal();
