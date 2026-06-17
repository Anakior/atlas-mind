function openResetPassword(email) {
  if (resetPwCloseTimer) { clearTimeout(resetPwCloseTimer); resetPwCloseTimer = null; }
  resetPwTargetEmail = email || '';
  resetPwEmail.textContent = resetPwTargetEmail;
  resetPwInput.value = '';
  resetPwConfirm.value = '';
  resetPwError.classList.add('hidden');
  resetPwSuccess.classList.add('hidden');
  setResetPwVisibility(false);
  refreshResetPwState();
  resetPwBackdrop.classList.remove('hidden');
  document.addEventListener('keydown', onResetPwKey, true);
  setTimeout(() => resetPwInput.focus(), 50);
}

function closeResetPassword() {
  if (resetPwCloseTimer) { clearTimeout(resetPwCloseTimer); resetPwCloseTimer = null; }
  resetPwBackdrop.classList.add('hidden');
  document.removeEventListener('keydown', onResetPwKey, true);
  resetPwTargetEmail = null;
}

function onResetPwKey(e) {
  // Capture-phase + stopPropagation so Esc closes ONLY this modal (stacked over
  // Settings), not the panel beneath, and runs before the global handler.
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeResetPassword(); }
}

resetPwInput.addEventListener('input', refreshResetPwState);
resetPwConfirm.addEventListener('input', refreshResetPwState);
resetPwToggle.addEventListener('click', () => setResetPwVisibility(resetPwInput.type === 'password'));
resetPwCancel.addEventListener('click', closeResetPassword);
resetPwClose.addEventListener('click', closeResetPassword);
resetPwBackdrop.addEventListener('click', (e) => { if (e.target === resetPwBackdrop) closeResetPassword(); });

resetPwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  resetPwError.classList.add('hidden');
  resetPwSuccess.classList.add('hidden');
  const validationError = resetPwValidationError();
  if (validationError) {
    resetPwError.textContent = validationError;
    resetPwError.classList.remove('hidden');
    return;
  }
  const email = resetPwTargetEmail;
  resetPwSubmit.disabled = true;
  try {
    await settingsFetch('/api/admin/users/password', {
      method: 'POST',
      body: JSON.stringify({ email, password: resetPwInput.value }),
    });
    clearSettingsError();
    resetPwSuccess.classList.remove('hidden');
    resetPwCloseTimer = setTimeout(closeResetPassword, 1200);
  } catch (err) {
    resetPwError.textContent = err.message;
    resetPwError.classList.remove('hidden');
    resetPwSubmit.disabled = false;
  }
});

// ── Share modal (admin + server mode) ────────────────────────────────────────
const btnShare = document.getElementById('btn-share');
const shareBackdrop = document.getElementById('share-backdrop');
const sharePath = document.getElementById('share-path');
const shareStep1 = document.getElementById('share-step1');
const shareStep2 = document.getElementById('share-step2');
const shareUrl = document.getElementById('share-url');
const shareCopy = document.getElementById('share-copy');
const shareExpiry = document.getElementById('share-expiry');
const shareError = document.getElementById('share-error');
const shareCancel = document.getElementById('share-cancel');
const shareClose = document.getElementById('share-close');
const shareNew = document.getElementById('share-new');
const shareExisting = document.getElementById('share-existing');
const shareExistingList = document.getElementById('share-existing-list');
const shareExistingCount = document.getElementById('share-existing-count');

function shareFormatDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString(LANG, { day: 'numeric', month: 'short', year: '2-digit' });
}

async function refreshShareList() {
  if (!currentFile) return;
  shareExisting.classList.add('hidden');
  shareExistingList.innerHTML = '';
  try {
    const res = await fetch('/api/share/list?path=' + encodeURIComponent(currentFile.path));
    if (!res.ok) return;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return;
    shareExisting.classList.remove('hidden');
    shareExistingCount.textContent = t('nLinks', items.length);
    shareExistingList.innerHTML = items.map(item => {
      const url = location.origin + '/s/' + item.token;
      const exp = item.expires_at ? t('expiresShort', shareFormatDate(item.expires_at)) : t('noExpiry');
      const created = item.created_at ? t('createdShort', shareFormatDate(item.created_at)) : '';
      return '<li class="bg-navy-900 border subtle-border rounded p-2 flex items-center gap-2 text-xs">' +
        '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-300 font-mono truncate" title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</div>' +
          '<div class="text-ink-500 text-[10px] mt-0.5">' + created + ' &middot; ' + exp + '</div>' +
        '</div>' +
        '<button class="share-existing-copy px-2 py-1 text-[11px] bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-url="' + escapeHtml(url) + '" title="' + escapeHtml(t('copy')) + '">' + t('copy') + '</button>' +
        '<button class="share-existing-del px-2 py-1 text-[11px] bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' + escapeHtml(item.id) + '" title="' + escapeHtml(t('revokeTitle')) + '">&times;</button>' +
      '</li>';
    }).join('');
  } catch (e) {}
}

