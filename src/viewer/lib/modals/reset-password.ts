// Password-reset modal (admin + cloud).
//
// ResetPwModal replaces the native prompt for setting a user's password (admin/cloud): entry +
// confirmation, opened from Settings via openResetPassword and stacked over it. It owns its field refs,
// the RESET_PW_MIN minimum and the validation/visibility helpers below — all read only by this modal.
// getElementById returns HTMLElement | null, so the modal asserts/casts at use.

// ── Reset password modal ─────────────────────────────────────────────────────
const RESET_PW_MIN = 8;
const resetPwBackdrop = document.getElementById('reset-pw-backdrop');
const resetPwForm = document.getElementById('reset-pw-form');
const resetPwEmail = document.getElementById('reset-pw-email');
const resetPwInput = document.getElementById('reset-pw-input') as HTMLInputElement;
const resetPwConfirm = document.getElementById('reset-pw-confirm') as HTMLInputElement;
const resetPwToggle = document.getElementById('reset-pw-toggle');
const resetPwEye = document.getElementById('reset-pw-eye');
const resetPwEyeOff = document.getElementById('reset-pw-eye-off');
const resetPwError = document.getElementById('reset-pw-error');
const resetPwSuccess = document.getElementById('reset-pw-success');
const resetPwSubmit = document.getElementById('reset-pw-submit') as HTMLButtonElement;
const resetPwCancel = document.getElementById('reset-pw-cancel');
const resetPwClose = document.getElementById('reset-pw-close');

function resetPwValidationError(): string | null {
  const pw = resetPwInput.value;
  const confirm = resetPwConfirm.value;

  if (pw.length < RESET_PW_MIN) return t('settingsPasswordTooShort');

  if (pw !== confirm) return t('settingsPasswordMismatch');

  return null;
}

function refreshResetPwState(): void {
  resetPwError!.classList.add('hidden');
  // Disable only while the 1st field is too short (immediate signal, doesn't block typing the
  // confirmation); otherwise stay enabled and show the precise error on submit.
  const tooShort = resetPwInput.value.length < RESET_PW_MIN;

  resetPwSubmit.disabled = tooShort || resetPwConfirm.value.length === 0;
}

function setResetPwVisibility(show: boolean): void {
  resetPwInput.type = show ? 'text' : 'password';
  resetPwConfirm.type = show ? 'text' : 'password';
  resetPwEye!.classList.toggle('hidden', show);
  resetPwEyeOff!.classList.toggle('hidden', !show);
  resetPwToggle!.setAttribute('aria-pressed', show ? 'true' : 'false');
}

class ResetPwModal {
  private targetEmail: string | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    resetPwInput!.addEventListener('input', refreshResetPwState);
    resetPwConfirm!.addEventListener('input', refreshResetPwState);
    resetPwToggle!.addEventListener('click', () =>
      setResetPwVisibility((resetPwInput as HTMLInputElement).type === 'password'),
    );
    resetPwCancel!.addEventListener('click', () => this.close());
    resetPwClose!.addEventListener('click', () => this.close());
    resetPwBackdrop!.addEventListener('click', (e) => {
      if (e.target === resetPwBackdrop) this.close();
    });
    resetPwForm!.addEventListener('submit', (e) => this.submit(e));
  }

  open(email?: string): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    this.targetEmail = email || '';
    resetPwEmail!.textContent = this.targetEmail;
    (resetPwInput as HTMLInputElement).value = '';
    (resetPwConfirm as HTMLInputElement).value = '';
    resetPwError!.classList.add('hidden');
    resetPwSuccess!.classList.add('hidden');
    setResetPwVisibility(false);
    refreshResetPwState();
    resetPwBackdrop!.classList.remove('hidden');
    document.addEventListener('keydown', this.onKey, true);
    setTimeout(() => (resetPwInput as HTMLInputElement).focus(), 50);
  }

  private close(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    resetPwBackdrop!.classList.add('hidden');
    document.removeEventListener('keydown', this.onKey, true);
    this.targetEmail = null;
  }

  // Capture-phase + stopPropagation so Esc closes ONLY this modal (stacked over Settings), not the
  // panel beneath, and runs before the global handler. Arrow field: a stable ref for add/remove.
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    resetPwError!.classList.add('hidden');
    resetPwSuccess!.classList.add('hidden');
    const validationError = resetPwValidationError();

    if (validationError) {
      resetPwError!.textContent = validationError;
      resetPwError!.classList.remove('hidden');

      return;
    }

    const email = this.targetEmail;

    (resetPwSubmit as HTMLButtonElement).disabled = true;

    try {
      await settingsFetch('/api/admin/users/password', {
        method: 'POST',
        body: JSON.stringify({ email, password: (resetPwInput as HTMLInputElement).value }),
      });
      clearSettingsError();
      resetPwSuccess!.classList.remove('hidden');
      this.closeTimer = setTimeout(() => this.close(), 1200);
    } catch (err) {
      resetPwError!.textContent = (err as Error).message;
      resetPwError!.classList.remove('hidden');
      (resetPwSubmit as HTMLButtonElement).disabled = false;
    }
  }
}

const resetPwModal = new ResetPwModal();

function openResetPassword(email?: string): void {
  resetPwModal.open(email);
}
