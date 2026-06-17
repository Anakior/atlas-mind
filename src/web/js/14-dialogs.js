function openRenameModal(mode) {
  if (!currentFile || window.__viewerMode) return;
  renameMode = mode;
  renameError.classList.add('hidden');
  renameDirs.innerHTML = getAllDirs().map(d => '<option value="' + escapeHtml(d) + '">').join('');
  const parts = currentFile.path.split('/');
  const currentName = parts.pop().replace(/\.(md|html)$/i, '');
  const currentDir = parts.join('/');
  renameName.value = currentName;
  renameDir.value = currentDir;
  if (mode === 'rename') {
    renameTitle.textContent = t('renameDocTitle');
    renameDirWrap.classList.add('hidden');
  } else {
    renameTitle.textContent = t('moveDocTitle');
    renameDirWrap.classList.remove('hidden');
  }
  renameBackdrop.classList.remove('hidden');
  setTimeout(() => (mode === 'rename' ? renameName : renameDir).focus(), 50);
}
function closeRenameModal() { renameBackdrop.classList.add('hidden'); }

btnMore.addEventListener('click', (e) => {
  e.stopPropagation();
  btnMoreMenu.classList.toggle('hidden');
});
document.addEventListener('click', () => btnMoreMenu.classList.add('hidden'));
btnMoreMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  btnMoreMenu.classList.add('hidden');
  const action = btn.dataset.action;
  if (action === 'rename') return openRenameModal('rename');
  if (action === 'move') return openRenameModal('move');
  if (action === 'delete') {
    const ok = await confirmDialog({
      title: t('deleteDocTitle'),
      message: t('deleteDocMsg', currentFile.path),
      confirmLabel: t('del'),
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch('/api/file', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFile.path }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      location.hash = '';
      setStatus(t('docDeleted'), 'ok');
      await refreshTreeOrReload();
    } catch (e) { alert(t('err', e.message)); }
  }
});

renameCancel.addEventListener('click', closeRenameModal);
renameBackdrop.addEventListener('click', (e) => { if (e.target === renameBackdrop) closeRenameModal(); });

renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  renameError.classList.add('hidden');
  let name = renameName.value.trim();
  if (!name) { renameError.textContent = t('nameRequired'); renameError.classList.remove('hidden'); return; }
  if (/[\\\/]/.test(name)) { renameError.textContent = t('noSlashes'); renameError.classList.remove('hidden'); return; }
  // Preserve the original extension if the user didn't type it.
  if (!/\.(md|html)$/i.test(name)) {
    const ext = (/\.(md|html)$/i.exec(currentFile.path) || [, 'md'])[1].toLowerCase();
    name += '.' + ext;
  }
  const dir = (renameMode === 'move' ? renameDir.value.trim() : currentFile.path.split('/').slice(0, -1).join('/'))
    .replace(/^\/+|\/+$/g, '');
  const newPath = dir ? dir + '/' + name : name;
  if (newPath === currentFile.path) { closeRenameModal(); return; }
  if (fileMap[newPath]) { renameError.textContent = t('fileExistsAt'); renameError.classList.remove('hidden'); return; }
  try {
    const res = await fetch('/api/file/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: currentFile.path, to: newPath }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || ('HTTP ' + res.status)); }
    closeRenameModal();
    // Move the content cache to the new path to avoid a needless re-fetch.
    const cached = contentCache.get(currentFile.path);
    if (cached !== undefined) {
      contentCache.delete(currentFile.path);
      contentCache.set(newPath, cached);
    }
    currentFile.path = newPath;
    location.hash = '#' + encodeURIComponent(newPath);
    setStatus(renameMode === 'move' ? t('docMoved') : t('docRenamed'), 'ok');
    await refreshTreeOrReload();
  } catch (e) {
    renameError.textContent = t('err', e.message);
    renameError.classList.remove('hidden');
  }
});

// ── Confirm dialog (replaces native confirm()) ───────────────────────────────
const confirmBackdrop = document.getElementById('confirm-backdrop');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmOk = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');

function confirmDialog(opts) {
  return new Promise(resolve => {
    const o = (typeof opts === 'string') ? { message: opts } : (opts || {});
    confirmTitle.textContent = o.title || t('confirm');
    confirmMessage.textContent = o.message || '';
    confirmOk.textContent = o.confirmLabel || t('confirm');
    confirmCancel.textContent = o.cancelLabel || t('cancel');
    confirmOk.className = o.destructive
      ? 'px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium'
      : 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium';
    confirmBackdrop.classList.remove('hidden');
    setTimeout(() => confirmOk.focus(), 50);
    const cleanup = () => {
      confirmBackdrop.classList.add('hidden');
      confirmOk.removeEventListener('click', onOk);
      confirmCancel.removeEventListener('click', onCancel);
      confirmBackdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = e => { if (e.target === confirmBackdrop) onCancel(); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    };
    confirmOk.addEventListener('click', onOk);
    confirmCancel.addEventListener('click', onCancel);
    confirmBackdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// Input modal (replaces the native prompt, banned from the viewer). Resolves the
// entered value (trimmed) or null if cancelled/empty.
function promptDialog(opts) {
  const o = opts || {};
  const backdrop = document.getElementById('prompt-backdrop');
  const input = document.getElementById('prompt-input');
  document.getElementById('prompt-title').textContent = o.title || '';
  document.getElementById('prompt-message').textContent = o.message || '';
  input.placeholder = o.placeholder || '';
  input.value = o.value || '';
  const okBtn = document.getElementById('prompt-ok');
  const cancelBtn = document.getElementById('prompt-cancel');
  okBtn.textContent = o.confirmLabel || t('confirm');
  return new Promise(resolve => {
    backdrop.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const cleanup = () => {
      backdrop.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onBackdrop = e => { if (e.target === backdrop) onCancel(); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ── Reset password modal (admin + cloud) ─────────────────────────────────────
// Replaces the native prompt: entry + confirmation, length validation (min 8),
// live equality check, show/hide toggle, inline success.
const RESET_PW_MIN = 8;
const resetPwBackdrop = document.getElementById('reset-pw-backdrop');
const resetPwForm = document.getElementById('reset-pw-form');
const resetPwEmail = document.getElementById('reset-pw-email');
const resetPwInput = document.getElementById('reset-pw-input');
const resetPwConfirm = document.getElementById('reset-pw-confirm');
const resetPwToggle = document.getElementById('reset-pw-toggle');
const resetPwEye = document.getElementById('reset-pw-eye');
const resetPwEyeOff = document.getElementById('reset-pw-eye-off');
const resetPwError = document.getElementById('reset-pw-error');
const resetPwSuccess = document.getElementById('reset-pw-success');
const resetPwSubmit = document.getElementById('reset-pw-submit');
const resetPwCancel = document.getElementById('reset-pw-cancel');
const resetPwClose = document.getElementById('reset-pw-close');
let resetPwTargetEmail = null;
let resetPwCloseTimer = null;

function resetPwValidationError() {
  const pw = resetPwInput.value;
  const confirm = resetPwConfirm.value;
  if (pw.length < RESET_PW_MIN) return t('settingsPasswordTooShort');
  if (pw !== confirm) return t('settingsPasswordMismatch');
  return null;
}

function refreshResetPwState() {
  resetPwError.classList.add('hidden');
  // Disable only while the 1st field is too short (immediate signal, doesn't block
  // typing the confirmation); otherwise stay enabled and show the precise error on submit.
  const tooShort = resetPwInput.value.length < RESET_PW_MIN;
  resetPwSubmit.disabled = tooShort || resetPwConfirm.value.length === 0;
}

function setResetPwVisibility(show) {
  resetPwInput.type = show ? 'text' : 'password';
  resetPwConfirm.type = show ? 'text' : 'password';
  resetPwEye.classList.toggle('hidden', show);
  resetPwEyeOff.classList.toggle('hidden', !show);
  resetPwToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
}

