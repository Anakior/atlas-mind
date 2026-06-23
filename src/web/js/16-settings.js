function openShareModal() {
  if (!currentFile || window.__viewerMode) return;
  sharePath.textContent = currentFile.path;
  shareStep1.classList.remove('hidden');
  shareStep2.classList.add('hidden');
  shareError.classList.add('hidden');
  shareBackdrop.classList.remove('hidden');
  refreshShareList();
}

function closeShareModal() {
  shareBackdrop.classList.add('hidden');
}

shareExistingList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.share-existing-copy');

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url);
      copyBtn.textContent = t('copied');
      setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
    } catch (e) {}

    return;
  }

  const delBtn = e.target.closest('.share-existing-del');

  if (delBtn) {
    const ok = await confirmDialog({
      title: t('revokeConfirmTitle'),
      message: t('revokeConfirmMsg'),
      confirmLabel: t('revoke'),
      destructive: true,
    });

    if (!ok) return;
    shareError.classList.add('hidden');

    try {
      const res = await fetch('/api/share/' + delBtn.dataset.id, { method: 'DELETE' });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      refreshShareList();
    } catch (e) {
      shareError.textContent = t('err', e.message);
      shareError.classList.remove('hidden');
    }
  }
});

btnShare.addEventListener('click', openShareModal);
shareCancel.addEventListener('click', closeShareModal);
shareClose.addEventListener('click', closeShareModal);
document.getElementById('share-close-x')?.addEventListener('click', closeShareModal);
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) closeShareModal();
});
shareNew.addEventListener('click', () => {
  shareStep2.classList.add('hidden');
  shareStep1.classList.remove('hidden');
});

document.querySelectorAll('.share-dur').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!currentFile) return;
    shareError.classList.add('hidden');
    const days = parseInt(btn.dataset.days, 10);

    btn.disabled = true;

    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFile.path, expires_days: days }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const fullUrl = location.origin + '/s/' + data.token;

      shareUrl.value = fullUrl;
      shareExpiry.textContent = data.expires_at
        ? t('expiresAt', new Date(data.expires_at * 1000).toLocaleString(LANG))
        : t('neverExpires');
      shareStep1.classList.add('hidden');
      shareStep2.classList.remove('hidden');
      setTimeout(() => {
        shareUrl.select();
      }, 50);
      refreshShareList();
    } catch (e) {
      shareError.textContent = t('err', e.message);
      shareError.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
});

shareCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    shareCopy.textContent = t('copiedBang');
    setTimeout(() => {
      shareCopy.textContent = t('copy');
    }, 1500);
  } catch (e) {
    shareUrl.select();
    document.execCommand('copy');
  }
});

// ── Settings panel (admin + cloud mode) ──────────────────────────────────────
// Entry point: user-bar gear, visible only when body.admin-cloud is set. All
// mutations go through fetch() on /api/admin/* and /api/share/* (JSON, same origin).
const settingsBtn = document.getElementById('settings-btn');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsClose = document.getElementById('settings-close');
const settingsError = document.getElementById('settings-error');
const settingsUsersList = document.getElementById('settings-users-list');
const settingsTokensList = document.getElementById('settings-tokens-list');
const settingsSharesList = document.getElementById('settings-shares-list');
const settingsUserForm = document.getElementById('settings-user-form');
const settingsTokenForm = document.getElementById('settings-token-form');
const settingsTokenResult = document.getElementById('settings-token-result');
const settingsInviteResult = document.getElementById('settings-invite-result');
const settingsNodesList = document.getElementById('settings-nodes-list');
const settingsNodeForm = document.getElementById('settings-node-form');
const settingsNodeResult = document.getElementById('settings-node-result');
const settingsRemotesList = document.getElementById('settings-remotes-list');
const settingsRemoteForm = document.getElementById('settings-remote-form');

// HTTP status → human message (never the raw technical detail).
function settingsHttpMessage(status) {
  if (status === 403 || status === 401) return t('settingsErrForbidden');

  if (status === 409) return t('settingsErrConflict');

  return t('settingsErrGeneric');
}

function showSettingsError(message) {
  settingsError.textContent = message;
  settingsError.classList.remove('hidden');
}

function clearSettingsError() {
  settingsError.classList.add('hidden');
}

// Shared JSON fetch for admin mutations: adds Content-Type, parses the body and
// raises a readable message (not the server detail) on failure.
async function settingsFetch(url, options) {
  const opts = Object.assign({ headers: {} }, options || {});

  if (opts.body) opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  const res = await fetch(url, opts);
  let payload = null;

  try {
    payload = await res.json();
  } catch (_) {}

  if (!res.ok) {
    const human =
      payload && payload.error === 'cannot delete the last admin'
        ? t('settingsLastAdmin')
        : settingsHttpMessage(res.status);
    const err = new Error(human);

    err.status = res.status;
    throw err;
  }

  return payload;
}

function settingsSelectTab(name) {
  document.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  });
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.classList.add('hidden');
  });
  document.getElementById('settings-pane-' + name).classList.remove('hidden');
  clearSettingsError();

  if (name === 'users') loadSettingsUsers();
  else if (name === 'tokens') loadSettingsTokens();
  else if (name === 'shares') loadSettingsShares();
  else if (name === 'nodes') {
    loadSettingsNodes();
    loadSettingsRemotes();
  } else if (name === 'groups') loadSettingsGroups();
  else if (name === 'security') {
    refreshSecurityState();
    loadAccountProfile();
  }
}

// Node name from a path: last segment, slugified.
function suggestNodeName(path) {
  const base = (String(path).split('/').pop() || path).replace(/\.(md|html)$/i, '');

  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'noeud'
  );
}

// Opens Settings → Nodes with the path pre-filled (from the tree button).
function openPublishNode(path) {
  openSettings();
  settingsSelectTab('nodes');
  hideNodeResult();
  const pathEl = document.getElementById('settings-node-path');
  const nameEl = document.getElementById('settings-node-name');

  if (pathEl) pathEl.value = path;

  if (nameEl) {
    nameEl.value = suggestNodeName(path);
    nameEl.focus();
    nameEl.select();
  }
}

// Info about the remote node a mirror doc belongs to (remotes/<name>/…).
function remoteNodeInfo(path) {
  const parts = (path || '').split('/');

  if (parts[0] !== 'remotes' || parts.length < 3) return null;
  const name = parts[1];
  const prefix = 'remotes/' + name + '/';
  const fileCount = Object.keys(fileMap).filter((p) => p.startsWith(prefix)).length;

  return { name, sourceRel: parts.slice(2).join('/'), fileCount };
}

// Appropriate from a mirror doc: node's only file → whole node, otherwise just
// that file. Produces a detached, editable copy in your documents.
document.getElementById('btn-node-appropriate').addEventListener('click', async () => {
  if (!currentFile) return;
  const info = remoteNodeInfo(currentFile.path);

  if (!info) return;
  const whole = info.fileCount <= 1;
  const dest = await promptDialog({
    title: t('nodeAppropriateBtn'),
    message: whole
      ? t('nodeAppropriateWholePrompt', info.name)
      : t('nodeAppropriateFilePrompt', currentFile.name),
    value: whole ? info.name : currentFile.name || '',
    confirmLabel: t('nodeAppropriateBtn'),
  });

  if (!dest) return;

  try {
    const res = await settingsFetch('/api/admin/remotes/appropriate', {
      method: 'POST',
      body: JSON.stringify({ name: info.name, source: whole ? '' : info.sourceRel, dest }),
    });

    setStatus(t('settingsRemoteAppropriated', String(res.copied || 0)), 'ok');
    await refreshTreeOrReload();
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// Remove from a mirror doc = unsubscribe entirely: a single removed file would
// just come back on the next sync, so we drop the whole subscription.
document.getElementById('btn-node-remove').addEventListener('click', async () => {
  if (!currentFile) return;
  const info = remoteNodeInfo(currentFile.path);

  if (!info) return;
  const ok = await confirmDialog({
    title: t('nodeRemoveTitle'),
    message: t('settingsRemoteRemoveMsg', info.name),
    confirmLabel: t('settingsRemoteRemove'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/remotes', {
      method: 'DELETE',
      body: JSON.stringify({ name: info.name }),
    });
    showWelcome();
    await refreshTreeOrReload();
  } catch (e) {
    setStatus(t('err', e.message), 'err');
  }
});

// ── Users ──
async function loadSettingsUsers() {
  settingsUsersList.innerHTML = '';

  try {
    const users = await settingsFetch('/api/admin/users');

    if (!Array.isArray(users) || users.length === 0) {
      settingsUsersList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoUsers') + '</li>';

      return;
    }

    settingsUsersList.innerHTML = users
      .map((u) => {
        const roleLabel = u.role === 'admin' ? t('settingsRoleAdmin') : t('settingsRoleViewer');
        const roleCls = u.role === 'admin' ? 'text-accent' : 'text-ink-400';
        const emailEsc = escapeHtml(u.email);
        const fullName = [u.first_name, u.last_name].map((p) => (p || '').trim()).filter(Boolean).join(' ');
        const nameLine = fullName
          ? '<div class="text-ink-100 font-medium truncate" title="' +
            escapeHtml(fullName) +
            '">' +
            escapeHtml(fullName) +
            '</div>'
          : '';
        // A pending account was invited but hasn't set a password yet: show a
        // badge, and offer "resend invite" instead of "reset password" (which 404s
        // on a pending account — the password is set via the invite link).
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
    showSettingsError(e.message);
  }
}

settingsUserForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const email = document.getElementById('settings-user-email').value.trim();
  const role = document.getElementById('settings-user-role').value;

  try {
    const data = await settingsFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    // One-time display: the invite link is returned once and never again.
    showInviteResult(data.invite_url);
    settingsUserForm.reset();
    loadSettingsUsers();
  } catch (err) {
    showSettingsError(err.message);
  }
});

settingsUsersList.addEventListener('click', async (e) => {
  const resendBtn = e.target.closest('.settings-user-resend');

  if (resendBtn) {
    try {
      const data = await settingsFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: resendBtn.dataset.email, role: resendBtn.dataset.role }),
      });
      showInviteResult(data.invite_url);
      loadSettingsUsers();
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const resetBtn = e.target.closest('.settings-user-reset');

  if (resetBtn) {
    openResetPassword(resetBtn.dataset.email);

    return;
  }

  const delBtn = e.target.closest('.settings-user-del');

  if (delBtn) {
    const ok = await confirmDialog({
      title: t('settingsDeleteUserTitle'),
      message: t('settingsDeleteUserMsg', delBtn.dataset.email),
      confirmLabel: t('settingsDeleteUser'),
      destructive: true,
    });

    if (!ok) return;

    try {
      await settingsFetch('/api/admin/users', {
        method: 'DELETE',
        body: JSON.stringify({ email: delBtn.dataset.email }),
      });
      loadSettingsUsers();
    } catch (err) {
      showSettingsError(err.message);
    }
  }
});

// ── Tokens ──
async function loadSettingsTokens() {
  settingsTokensList.innerHTML = '';

  try {
    const tokens = await settingsFetch('/api/tokens');
    const active = Array.isArray(tokens) ? tokens.filter((tk) => !tk.revoked) : [];

    if (active.length === 0) {
      settingsTokensList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoTokens') + '</li>';

      return;
    }

    settingsTokensList.innerHTML = active
      .map((tk) => {
        const created = tk.created_at ? t('createdShort', shareFormatDate(tk.created_at)) : '';
        const labelText = tk.label || tk.email || '';
        const labelEsc = escapeHtml(labelText);

        return (
          '<li class="admin-row bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate" title="' +
          labelEsc +
          '">' +
          labelEsc +
          '</div>' +
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(created) +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-token-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-id="' +
          escapeHtml(tk.id || '') +
          '" data-label="' +
          labelEsc +
          '">' +
          t('settingsRevokeToken') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

settingsTokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const labelInput = document.getElementById('settings-token-label');
  const label = labelInput.value.trim();

  if (!label) return;

  try {
    const data = await settingsFetch('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ label }),
    });

    // One-time display: the plaintext token NEVER comes back after this point.
    document.getElementById('settings-token-plain').value = data.token || '';
    document.getElementById('settings-token-mcp').value = data.mcp_url || '';
    settingsTokenResult.classList.remove('hidden');
    labelInput.value = '';
    loadSettingsTokens();
  } catch (err) {
    showSettingsError(err.message);
  }
});

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch (_) {
    return false;
  }
}

function flashCopied(btn) {
  btn.textContent = t('copied');
  btn.classList.add('is-copied');
  setTimeout(() => {
    btn.textContent = t('copy');
    btn.classList.remove('is-copied');
  }, 1200);
}

document.getElementById('settings-token-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-token-plain');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
  // Hide the secret after the flash — it's in the clipboard and never reappears.
  setTimeout(hideTokenResult, 1400);
});
document.getElementById('settings-token-mcp-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-token-mcp');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

function hideTokenResult() {
  settingsTokenResult.classList.add('hidden');
  // Clear the secret from the DOM — no residue in the inspector.
  document.getElementById('settings-token-plain').value = '';
  document.getElementById('settings-token-mcp').value = '';
}

document.getElementById('settings-token-close').addEventListener('click', hideTokenResult);

// ── Invite link one-time display (mirror of the token result) ──
function showInviteResult(url) {
  if (!url) return;
  document.getElementById('settings-invite-link').value = url;
  settingsInviteResult.classList.remove('hidden');
}

function hideInviteResult() {
  settingsInviteResult.classList.add('hidden');
  document.getElementById('settings-invite-link').value = '';
}

document.getElementById('settings-invite-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-invite-link');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

document.getElementById('settings-invite-close').addEventListener('click', hideInviteResult);

settingsTokensList.addEventListener('click', async (e) => {
  const revokeBtn = e.target.closest('.settings-token-revoke');

  if (!revokeBtn) return;
  const ok = await confirmDialog({
    title: t('settingsRevokeTokenTitle'),
    message: t('settingsRevokeTokenMsg', revokeBtn.dataset.label),
    confirmLabel: t('settingsRevokeToken'),
    destructive: true,
  });

  if (!ok) return;

  try {
    // Prefer id over label: the label may be reused after revocation.
    const body = revokeBtn.dataset.id
      ? { id: revokeBtn.dataset.id }
      : { label: revokeBtn.dataset.label };

    await settingsFetch('/api/tokens', {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
    loadSettingsTokens();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Shares ──
async function loadSettingsShares() {
  settingsSharesList.innerHTML = '';

  try {
    const shares = await settingsFetch('/api/share/list');

    if (!Array.isArray(shares) || shares.length === 0) {
      settingsSharesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoShares') + '</li>';

      return;
    }

    settingsSharesList.innerHTML = shares
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
    showSettingsError(e.message);
  }
}

settingsSharesList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.settings-share-copy');

  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url);
      copyBtn.textContent = t('copied');
      setTimeout(() => (copyBtn.textContent = t('copy')), 1200);
    } catch (_) {}

    return;
  }

  const reactivateBtn = e.target.closest('.settings-share-reactivate');

  if (reactivateBtn) {
    // Doc moved/disappeared: point the link at its new path (URL stays the same).
    const newPath = await promptDialog({
      title: t('shareReactivateTitle'),
      message: t('shareReactivateMsg', reactivateBtn.dataset.path || ''),
      value: reactivateBtn.dataset.suggested || '',
      placeholder: t('shareReactivatePlaceholder'),
      confirmLabel: t('shareReactivate'),
    });

    if (!newPath) return;

    try {
      await settingsFetch('/api/share/' + reactivateBtn.dataset.id, {
        method: 'PATCH',
        body: JSON.stringify({ path: newPath.trim() }),
      });
      loadSettingsShares();
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const revokeBtn = e.target.closest('.settings-share-revoke');

  if (!revokeBtn || !revokeBtn.dataset.id) return;
  const ok = await confirmDialog({
    title: t('revokeConfirmTitle'),
    message: t('revokeConfirmMsg'),
    confirmLabel: t('revoke'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/share/' + revokeBtn.dataset.id, { method: 'DELETE' });
    loadSettingsShares();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Nodes (hive) ──
async function loadSettingsNodes() {
  settingsNodesList.innerHTML = '';

  try {
    const nodes = await settingsFetch('/api/admin/nodes');
    const active = Array.isArray(nodes) ? nodes.filter((n) => !n.revoked) : [];

    if (active.length === 0) {
      settingsNodesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoNodes') + '</li>';

      return;
    }

    settingsNodesList.innerHTML = active
      .map((n) => {
        const created = n.created_at ? t('createdShort', shareFormatDate(n.created_at)) : '';
        const nameEsc = escapeHtml(n.name || '');
        const pathEsc = escapeHtml(n.path || '');

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
          '<div class="text-ink-500 text-xs mt-0.5">' +
          escapeHtml(created) +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-node-relink px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '" data-path="' +
          pathEsc +
          '" title="' +
          escapeHtml(t('settingsNodeRelinkTitle')) +
          '">' +
          t('settingsNodeRelink') +
          '</button>' +
          '<button class="settings-node-revoke px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('revoke') +
          '</button>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

async function publishNode(name, path) {
  // One-time display: the link (which carries the token) NEVER comes back after.
  const data = await settingsFetch('/api/admin/nodes', {
    method: 'POST',
    body: JSON.stringify({ name, path }),
  });

  document.getElementById('settings-node-link').value = data.link || '';
  settingsNodeResult.classList.remove('hidden');
  loadSettingsNodes();
}

settingsNodeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const name = document.getElementById('settings-node-name').value.trim();
  const path = document.getElementById('settings-node-path').value.trim();

  if (!name || !path) return;

  try {
    await publishNode(name, path);
    settingsNodeForm.reset();
  } catch (err) {
    showSettingsError(err.message);
  }
});

document.getElementById('settings-node-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('settings-node-link');
  const ok = await copyToClipboard(input.value);

  if (!ok) {
    input.select();
    document.execCommand('copy');
  }

  flashCopied(btn);
});

function hideNodeResult() {
  settingsNodeResult.classList.add('hidden');
  document.getElementById('settings-node-link').value = '';
}

document.getElementById('settings-node-close').addEventListener('click', hideNodeResult);

settingsNodesList.addEventListener('click', async (e) => {
  const relinkBtn = e.target.closest('.settings-node-relink');

  if (relinkBtn) {
    // Re-publishing regenerates the token (old link dies), but it's the only way
    // to get a copyable link back — hence the warning.
    const ok = await confirmDialog({
      title: t('settingsNodeRelinkTitle'),
      message: t('settingsNodeRelinkMsg', relinkBtn.dataset.name),
      confirmLabel: t('settingsNodeRelink'),
    });

    if (!ok) return;

    try {
      await publishNode(relinkBtn.dataset.name, relinkBtn.dataset.path);
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const revokeBtn = e.target.closest('.settings-node-revoke');

  if (!revokeBtn || !revokeBtn.dataset.name) return;
  const ok = await confirmDialog({
    title: t('settingsRevokeNodeTitle'),
    message: t('settingsRevokeNodeMsg', revokeBtn.dataset.name),
    confirmLabel: t('revoke'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/nodes', {
      method: 'DELETE',
      body: JSON.stringify({ name: revokeBtn.dataset.name }),
    });
    loadSettingsNodes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Subscriptions (followed remote nodes) ──
async function loadSettingsRemotes() {
  settingsRemotesList.innerHTML = '';

  try {
    const remotes = await settingsFetch('/api/admin/remotes');

    if (!Array.isArray(remotes) || remotes.length === 0) {
      settingsRemotesList.innerHTML =
        '<li class="text-sm text-ink-500">' + t('settingsNoRemotes') + '</li>';

      return;
    }

    settingsRemotesList.innerHTML = remotes
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
    showSettingsError(e.message);
  }
}

settingsRemoteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearSettingsError();
  const input = document.getElementById('settings-remote-link');
  const link = input.value.trim();

  if (!link) return;

  try {
    const res = await settingsFetch('/api/admin/remotes', {
      method: 'POST',
      body: JSON.stringify({ link }),
    });

    input.value = '';

    // Issuer unreachable: sync fails but the subscription is created — report
    // without blocking (the periodic sync retries).
    if (res && res.sync && res.sync.ok === false) {
      showSettingsError(t('settingsRemoteSyncFailed', res.sync.error || ''));
    }

    loadSettingsRemotes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

settingsRemotesList.addEventListener('click', async (e) => {
  const syncBtn = e.target.closest('.settings-remote-sync');

  if (syncBtn) {
    syncBtn.disabled = true;

    try {
      const res = await settingsFetch('/api/admin/remotes/sync', {
        method: 'POST',
        body: JSON.stringify({ name: syncBtn.dataset.name }),
      });
      const r = res && res.results ? res.results[syncBtn.dataset.name] : null;

      if (r && r.ok === false) showSettingsError(t('settingsRemoteSyncFailed', r.error || ''));
    } catch (err) {
      showSettingsError(err.message);
    }

    loadSettingsRemotes();

    return;
  }

  const apprBtn = e.target.closest('.settings-remote-appropriate');

  if (apprBtn) {
    const name = apprBtn.dataset.name;
    // Free-form destination via modal. Default = node name, at the root of your documents.
    const dest = await promptDialog({
      title: t('settingsRemoteAppropriate'),
      message: t('settingsRemoteAppropriatePrompt', name),
      value: name,
      placeholder: t('appropriateDestPlaceholder'),
      confirmLabel: t('settingsRemoteAppropriate'),
    });

    if (!dest) return;

    try {
      const res = await settingsFetch('/api/admin/remotes/appropriate', {
        method: 'POST',
        body: JSON.stringify({ name, source: '', dest }),
      });

      showSettingsError(t('settingsRemoteAppropriated', String(res.copied || 0)));
    } catch (err) {
      showSettingsError(err.message);
    }

    return;
  }

  const delBtn = e.target.closest('.settings-remote-del');

  if (!delBtn || !delBtn.dataset.name) return;
  const ok = await confirmDialog({
    title: t('settingsRemoteRemoveTitle'),
    message: t('settingsRemoteRemoveMsg', delBtn.dataset.name),
    confirmLabel: t('settingsRemoteRemove'),
    destructive: true,
  });

  if (!ok) return;

  try {
    await settingsFetch('/api/admin/remotes', {
      method: 'DELETE',
      body: JSON.stringify({ name: delBtn.dataset.name }),
    });
    loadSettingsRemotes();
  } catch (err) {
    showSettingsError(err.message);
  }
});

// ── Groups (principals group:<name>) ──
async function loadSettingsGroups() {
  const list = document.getElementById('settings-groups-list');

  if (!list) return;
  list.innerHTML = '';

  try {
    const groups = await settingsFetch('/api/admin/groups'); // { name: [emails] }
    const names = Object.keys(groups || {}).sort();

    if (!names.length) {
      list.innerHTML = '<li class="text-sm text-ink-500">' + t('settingsNoGroups') + '</li>';

      return;
    }

    list.innerHTML = names
      .map((name) => {
        const members = groups[name] || [];
        const nameEsc = escapeHtml(name);
        const membersEsc = escapeHtml(members.join(', '));

        return (
          '<li class="bg-navy-900 border subtle-border rounded p-2.5 text-sm">' +
          '<div class="admin-row">' +
          '<div class="flex-1 min-w-0">' +
          '<div class="text-ink-100 font-medium font-mono truncate">' +
          nameEsc +
          '</div>' +
          '<div class="text-ink-400 text-xs mt-0.5 truncate" title="' +
          membersEsc +
          '">' +
          (members.length
            ? membersEsc
            : '<span class="text-ink-500">' + t('settingsGroupEmpty') + '</span>') +
          '</div>' +
          '</div>' +
          '<div class="admin-row__actions">' +
          '<button class="settings-group-edit px-3 py-1.5 text-sm bg-navy-700 hover:bg-navy-600 text-ink-200 rounded" data-name="' +
          nameEsc +
          '" data-members="' +
          membersEsc +
          '">' +
          t('settingsGroupEdit') +
          '</button>' +
          '<button class="settings-group-del px-3 py-1.5 text-sm bg-navy-700 hover:bg-rose-500/30 hover:text-rose-300 text-ink-200 rounded" data-name="' +
          nameEsc +
          '">' +
          t('settingsGroupDelete') +
          '</button>' +
          '</div>' +
          '</div>' +
          '</li>'
        );
      })
      .join('');
  } catch (e) {
    showSettingsError(e.message);
  }
}

// Node path = a creatable combobox over the mind's existing folders (publish an existing
// folder as a federation node, or type a new path) — like the new-file folder field.
const settingsNodePathEl = document.getElementById('settings-node-path');
if (settingsNodePathEl) AtlasCombobox(settingsNodePathEl, { source: getAllDirs, creatable: true });

const settingsGroupForm = document.getElementById('settings-group-form');

if (settingsGroupForm) {
  // Members = a creatable multi/chips combobox (pick known accounts via /api/directory
  // or type a new email), replacing the bare comma-separated input.
  const groupMembersCb = AtlasCombobox(document.getElementById('settings-group-members'), {
    source: async () => {
      try {
        const r = await fetch('/api/directory');
        return r.ok ? (await r.json()).users || [] : [];
      } catch (_) {
        return [];
      }
    },
    creatable: true,
    multi: true,
    separator: ',',
  });

  settingsGroupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearSettingsError();
    const name = document.getElementById('settings-group-name').value.trim();
    const members = groupMembersCb.getValue();

    try {
      await settingsFetch('/api/admin/groups', {
        method: 'POST',
        body: JSON.stringify({ name, members }),
      });
      settingsGroupForm.reset();
      groupMembersCb.clear();
      loadSettingsGroups();
    } catch (err) {
      showSettingsError(err.message);
    }
  });

  document.getElementById('settings-groups-list').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.settings-group-edit');

    if (editBtn) {
      document.getElementById('settings-group-name').value = editBtn.dataset.name;
      groupMembersCb.setValue(editBtn.dataset.members);
      document.getElementById('settings-group-name').focus();

      return;
    }

    const delBtn = e.target.closest('.settings-group-del');

    if (delBtn) {
      const ok = await confirmDialog({
        title: t('settingsGroupDeleteTitle'),
        message: t('settingsGroupDeleteMsg', delBtn.dataset.name),
        confirmLabel: t('settingsGroupDelete'),
        destructive: true,
      });

      if (!ok) return;

      try {
        await settingsFetch('/api/admin/groups', {
          method: 'DELETE',
          body: JSON.stringify({ name: delBtn.dataset.name }),
        });
        loadSettingsGroups();
      } catch (err) {
        showSettingsError(err.message);
      }
    }
  });
}

async function refreshUpdateBanner() {
  // Admin-only, best-effort: never block Settings if the check fails/offline.
  const banner = document.getElementById('settings-update-banner');

  if (!banner) return;
  banner.classList.add('hidden');

  try {
    const data = await settingsFetch('/api/admin/update-check');

    if (data && data.update_available && data.latest) {
      banner.textContent = t('settingsUpdateAvailable')
        .replace('{latest}', data.latest)
        .replace('{current}', data.current || '?');
      banner.href = data.url || 'https://pypi.org/project/atlas-mind/';
      banner.classList.remove('hidden');
    }
  } catch (_) {
    /* best-effort */
  }
}

function openSettings() {
  hideTokenResult();
  settingsBackdrop.classList.remove('hidden');
  // Everyone lands on Profile (the per-account tab, first in the bar); admin-only
  // tabs are one click away.
  const isAdmin = document.body.classList.contains('admin-cloud');

  settingsSelectTab('security');

  if (isAdmin) refreshUpdateBanner();
}

function closeSettings() {
  settingsBackdrop.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsBackdrop.addEventListener('click', (e) => {
  if (e.target === settingsBackdrop) closeSettings();
});
document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => settingsSelectTab(tab.dataset.tab));
});

// ── Your name (self-service, Profil tab) ──────────────────────────────────────
// The form is static in 05-settings.html; here we just prefill + save it.
async function loadAccountProfile() {
  const form = document.getElementById('account-profile-form');
  const first = document.getElementById('account-profile-first');
  const last = document.getElementById('account-profile-last');
  if (!form || !first || !last) return;
  if (!form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', saveAccountProfile);
  }
  try {
    const data = await settingsFetch('/api/account/profile');
    first.value = data.first_name || '';
    last.value = data.last_name || '';
    const avatar = document.getElementById('account-profile-avatar');
    if (avatar && data.email) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 64);
  } catch (e) {
    showSettingsError(e.message);
  }
}

async function saveAccountProfile(e) {
  e.preventDefault();
  clearSettingsError();
  const btn = e.target.querySelector('button[type="submit"]');
  const first = document.getElementById('account-profile-first').value.trim();
  const last = document.getElementById('account-profile-last').value.trim();
  btn.disabled = true;
  try {
    await settingsFetch('/api/account/profile', {
      method: 'POST',
      body: JSON.stringify({ first_name: first, last_name: last }),
    });
    const status = document.getElementById('account-profile-status');
    if (status) {
      status.textContent = t('profileSaved');
      status.classList.remove('hidden');
      setTimeout(() => status.classList.add('hidden'), 2500);
    }
  } catch (err) {
    showSettingsError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Minimal QR code generator (no external lib) ───────────────────────────────
// QR Model 2, byte mode, EC level L — enough for an otpauth:// URI (~120 bytes →
// version 6/7).
// On encoding failure (improbably long URI) the caller falls back to the plaintext secret.
