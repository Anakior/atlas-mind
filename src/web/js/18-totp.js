function openTotpModal(mode) {
  clearTotpError();
  totpStepEnroll.classList.toggle('hidden', mode !== 'enroll');
  totpStepRecovery.classList.add('hidden');
  totpStepDisable.classList.toggle('hidden', mode !== 'disable');
  totpTitle.textContent = mode === 'disable' ? t('totpModalDisableTitle') : t('totpModalTitle');
  totpBackdrop.classList.remove('hidden');
  document.addEventListener('keydown', onTotpKey, true);
}

// Enable 2FA: init (secret + URI) → show QR + secret → verification.
securityTotpEnableBtn.addEventListener('click', async () => {
  securityTotpEnableBtn.disabled = true;

  try {
    const data = await settingsFetch('/api/account/totp/init', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    totpSecretValue.value = data.secret || '';
    totpVerifyCode.value = '';
    // QR rendered client-side; silent fallback to the plaintext secret if the
    // URI is too long for our encoder.
    totpQr.innerHTML = '';
    const ok = data.otpauth_uri && renderQrCode(totpQr, data.otpauth_uri, 184);

    totpQr.classList.toggle('hidden', !ok);
    openTotpModal('enroll');
    setTimeout(() => totpVerifyCode.focus(), 60);
  } catch (err) {
    showSettingsError(err.message || t('settingsErrGeneric'));
  } finally {
    securityTotpEnableBtn.disabled = false;
  }
});

totpVerifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTotpError();
  const code = totpVerifyCode.value.trim();

  if (!code) {
    showTotpError(t('totpCodeRequired'));

    return;
  }

  totpVerifySubmit.disabled = true;

  try {
    const data = await settingsFetch('/api/account/totp/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    // enable bumps the epoch → fresh session + kb_csrf cookies; reload the CSRF
    // token so the next mutating requests don't break.
    setCsrfToken(readCsrfCookie());
    totpEnabled = true;
    refreshSecurityState();
    // Recovery codes are shown ONCE.
    pendingRecoveryCodes = Array.isArray(data.recovery_codes) ? data.recovery_codes : [];
    totpRecoveryList.innerHTML = pendingRecoveryCodes
      .map(
        (c) =>
          '<li class="bg-black/40 border subtle-border rounded px-2 py-1.5 text-center select-all">' +
          escapeHtml(c) +
          '</li>',
      )
      .join('');
    totpStepEnroll.classList.add('hidden');
    totpStepRecovery.classList.remove('hidden');
    setStatus(t('totpEnabledToast'), 'ok');
  } catch (err) {
    showTotpError(
      err.status === 400 ? t('totpInvalidCode') : err.message || t('settingsErrGeneric'),
    );
  } finally {
    totpVerifySubmit.disabled = false;
  }
});

totpSecretCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(totpSecretValue.value);
    totpSecretCopy.textContent = t('copied');
    setTimeout(() => (totpSecretCopy.textContent = t('copy')), 1200);
  } catch (e) {
    totpSecretValue.select();
  }
});
totpRecoveryCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pendingRecoveryCodes.join('\n'));
    totpRecoveryCopy.textContent = t('copied');
    setTimeout(() => (totpRecoveryCopy.textContent = t('totpRecoveryCopy')), 1200);
  } catch (e) {}
});
totpEnrollCancel.addEventListener('click', closeTotpModal);
totpRecoveryDone.addEventListener('click', closeTotpModal);
totpClose.addEventListener('click', () => {
  if (totpStepRecovery.classList.contains('hidden')) closeTotpModal();
});
totpBackdrop.addEventListener('click', (e) => {
  if (e.target === totpBackdrop && totpStepRecovery.classList.contains('hidden')) closeTotpModal();
});

// Disable 2FA: asks for a code (TOTP or recovery).
securityTotpDisableBtn.addEventListener('click', () => {
  totpDisableCode.value = '';
  openTotpModal('disable');
  setTimeout(() => totpDisableCode.focus(), 60);
});
totpDisableForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearTotpError();
  const code = totpDisableCode.value.trim();

  if (!code) {
    showTotpError(t('totpCodeRequired'));

    return;
  }

  totpDisableSubmit.disabled = true;

  try {
    // A 6-digit code = TOTP; otherwise treated as a recovery code.
    const body = /^[0-9]{6}$/.test(code) ? { code } : { recovery: code };

    await settingsFetch('/api/account/totp/disable', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setCsrfToken(readCsrfCookie());
    totpEnabled = false;
    refreshSecurityState();
    closeTotpModal();
    setStatus(t('totpDisabledToast'), 'ok');
  } catch (err) {
    showTotpError(
      err.status === 400 ? t('totpInvalidCode') : err.message || t('settingsErrGeneric'),
    );
  } finally {
    totpDisableSubmit.disabled = false;
  }
});

// Log out all my sessions: in-app confirmation then redirect to /login.
securityLogoutAllBtn.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: t('securityLogoutAllConfirmTitle'),
    message: t('securityLogoutAllConfirmMsg'),
    confirmLabel: t('securityLogoutAllConfirm'),
    destructive: true,
  });

  if (!ok) return;
  securityLogoutAllBtn.disabled = true;

  try {
    await settingsFetch('/api/account/logout-all', { method: 'POST', body: JSON.stringify({}) });
    // Epoch changed: current session is revoked (cookie cleared server-side) → /login.
    window.location = '/login';
  } catch (err) {
    showSettingsError(err.message || t('settingsErrGeneric'));
    securityLogoutAllBtn.disabled = false;
  }
});

// ── Quick capture ────────────────────────────────────────────────────────────
const qcBtn = document.getElementById('quick-capture-btn');
const qcBackdrop = document.getElementById('quick-capture-backdrop');
const qcForm = document.getElementById('quick-capture-form');
const qcTitle = document.getElementById('quick-capture-title');
const qcBody = document.getElementById('quick-capture-body');
const qcCancel = document.getElementById('quick-capture-cancel');
const qcError = document.getElementById('quick-capture-error');
