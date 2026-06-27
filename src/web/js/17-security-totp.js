// QR-to-canvas bridge + Security/2FA (TOTP) modal wiring. Split out of the old 17-qr.js:
// the pure codec now lives in 17-qr.ts (the QrCode class); this is the DOM side. Stays
// .js (migrated later). Sorts after 17-qr.ts and before 18-totp.js, which finishes the
// 2FA flow and is the sole caller of renderQrCode (via the enable handler).

// Renders an encoded QR into a container via a crisp <canvas> (square pixels).
function renderQrCode(container, text, sizePx) {
  const matrix = new QrCode(text).matrix;

  if (!matrix) return false;
  const n = matrix.length,
    quiet = 4,
    total = n + quiet * 2;
  const scale = Math.max(2, Math.floor((sizePx || 180) / total));
  const px = total * scale;
  const canvas = document.createElement('canvas');

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = px + 'px';
  canvas.style.height = px + 'px';
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';

  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }

  container.innerHTML = '';
  container.appendChild(canvas);

  return true;
}

// ── Security: 2FA (TOTP) + sessions ──────────────────────────────────────────
const securityTotpStatus = document.getElementById('security-totp-status');
const securityTotpEnableBtn = document.getElementById('security-totp-enable');
const securityTotpDisableBtn = document.getElementById('security-totp-disable');
const securityLogoutAllBtn = document.getElementById('security-logout-all');

const totpBackdrop = document.getElementById('totp-backdrop');
const totpTitle = document.getElementById('totp-title');
const totpError = document.getElementById('totp-error');
const totpClose = document.getElementById('totp-close');
const totpStepEnroll = document.getElementById('totp-step-enroll');
const totpStepRecovery = document.getElementById('totp-step-recovery');
const totpStepDisable = document.getElementById('totp-step-disable');
const totpQr = document.getElementById('totp-qr');
const totpSecretValue = document.getElementById('totp-secret-value');
const totpSecretCopy = document.getElementById('totp-secret-copy');
const totpVerifyForm = document.getElementById('totp-verify-form');
const totpVerifyCode = document.getElementById('totp-verify-code');
const totpVerifySubmit = document.getElementById('totp-verify-submit');
const totpEnrollCancel = document.getElementById('totp-enroll-cancel');
const totpRecoveryList = document.getElementById('totp-recovery-list');
const totpRecoveryCopy = document.getElementById('totp-recovery-copy');
const totpRecoveryDone = document.getElementById('totp-recovery-done');
const totpDisableForm = document.getElementById('totp-disable-form');
const totpDisableCode = document.getElementById('totp-disable-code');
const totpDisableSubmit = document.getElementById('totp-disable-submit');
const totpDisableCancel = document.getElementById('totp-disable-cancel');
let pendingRecoveryCodes = [];

function refreshSecurityState() {
  // totpEnabled is updated by /api/me and by the enable/disable actions.
  securityTotpStatus.textContent = totpEnabled
    ? t('securityTotpStatusOn')
    : t('securityTotpStatusOff');
  securityTotpStatus.classList.toggle('bg-emerald-500/20', totpEnabled);
  securityTotpStatus.classList.toggle('text-emerald-300', totpEnabled);
  securityTotpStatus.classList.toggle('bg-ink-500/15', !totpEnabled);
  securityTotpStatus.classList.toggle('text-ink-400', !totpEnabled);
  securityTotpEnableBtn.classList.toggle('hidden', totpEnabled);
  securityTotpDisableBtn.classList.toggle('hidden', !totpEnabled);
}

function showTotpError(msg) {
  totpError.textContent = msg;
  totpError.classList.remove('hidden');
}

function clearTotpError() {
  totpError.classList.add('hidden');
  totpError.textContent = '';
}

function closeTotpModal() {
  totpBackdrop.classList.add('hidden');
  document.removeEventListener('keydown', onTotpKey, true);
  pendingRecoveryCodes = [];
}

function onTotpKey(e) {
  // Capture + stopPropagation so Escape closes only the 2FA modal, never the
  // Settings panel underneath. While recovery codes are shown, Escape is blocked
  // entirely (explicit "Done" required).
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();

  if (totpStepRecovery.classList.contains('hidden')) closeTotpModal();
}
