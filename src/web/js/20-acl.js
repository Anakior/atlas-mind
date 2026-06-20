// ── Access & sharing (per-document ACL) ──────────────────────────────────────
// The "Accès" button on a doc opens a dialog to see/own/share it with users,
// groups, or everyone — backed by /api/acl. Read-only for a non-manager.
(function () {
  const backdrop = document.getElementById('acl-backdrop');

  if (!backdrop) return; // offline build without the dialog partial

  const pathEl = document.getElementById('acl-path');
  const statusEl = document.getElementById('acl-status');
  const grantsEl = document.getElementById('acl-grants');
  const manageEl = document.getElementById('acl-manage');
  const form = document.getElementById('acl-grant-form');
  const kindSel = document.getElementById('acl-kind');
  const valueInp = document.getElementById('acl-value');
  const levelSel = document.getElementById('acl-level');
  const errEl = document.getElementById('acl-error');

  let cur = null; // { path, owner, grants, can_manage }
  let dir = null; // { users:[emails], groups:[names] } — cached for autocompletion

  // The value field is a creatable combobox: pick a known user/group OR type a new
  // one. Its source flips with the kind select (users vs groups) → refresh() on change.
  const aclCb = AtlasCombobox(valueInp, {
    source: () => (kindSel.value === 'group' ? (dir && dir.groups) || [] : (dir && dir.users) || []),
    creatable: true,
  });

  async function loadDir() {
    if (!dir) {
      try {
        const r = await fetch('/api/directory');
        if (r.ok) dir = await r.json();
      } catch (_) {
        /* best-effort */
      }
    }
    return dir || { users: [], groups: [] };
  }

  function myPrincipal() {
    return meState && meState.email ? 'user:' + meState.email : null;
  }

  function principalLabel(p) {
    if (p === '*') return '🌐 ' + t('aclEveryone');
    if (p.startsWith('user:')) return '👤 ' + p.slice(5);
    if (p.startsWith('group:')) return '👥 ' + p.slice(6);
    if (p.startsWith('anon:')) return '🔗 ' + t('aclLinkPrincipal');

    return p;
  }

  function levelLabel(l) {
    if (l === 'edit') return t('aclLevelEdit');
    if (l === 'comment') return t('aclLevelComment');

    return t('aclLevelView');
  }

  function render() {
    pathEl.textContent = cur.path;

    if (cur.owner) {
      const mine = myPrincipal();
      const who = mine && cur.owner === mine
        ? t('aclYou')
        : cur.owner.startsWith('user:') ? cur.owner.slice(5) : cur.owner;
      statusEl.innerHTML =
        '<span class="text-amber-300 font-medium">' + escapeHtml(t('aclPrivate')) + '</span> · ' +
        escapeHtml(t('aclOwner')) + ' ' + escapeHtml(who);
    } else {
      statusEl.innerHTML =
        '<span class="text-emerald-300 font-medium">' + escapeHtml(t('aclCommons')) + '</span>';
    }

    if (cur.creator) {
      const mine = myPrincipal();
      const who = mine && cur.creator === mine
        ? t('aclYou')
        : cur.creator.startsWith('user:') ? cur.creator.slice(5) : cur.creator;
      statusEl.innerHTML +=
        ' <span class="text-ink-500">· ' + escapeHtml(t('aclCreatedBy')) + ' ' + escapeHtml(who) + '</span>';
    }

    const grants = cur.grants || [];

    grantsEl.innerHTML = grants.length
      ? grants
          .map(
            (g) =>
              '<li class="flex items-center justify-between gap-2 bg-navy-900 border subtle-border rounded px-2.5 py-1.5 text-xs">' +
              '<span class="truncate text-ink-200">' +
              escapeHtml(principalLabel(g.principal)) +
              ' · <span class="text-ink-400">' +
              escapeHtml(levelLabel(g.level)) +
              '</span></span>' +
              (cur.can_manage
                ? '<button class="acl-revoke text-ink-500 hover:text-rose-300 px-1 flex-shrink-0" data-principal="' +
                  escapeHtml(g.principal) +
                  '" title="' +
                  escapeHtml(t('aclRemove')) +
                  '">✕</button>'
                : '') +
              '</li>',
          )
          .join('')
      : '<li class="text-[11px] text-ink-500">' + escapeHtml(t('aclNoGrants')) + '</li>';

    manageEl.classList.toggle('hidden', !cur.can_manage);
    errEl.classList.add('hidden');
  }

  async function refresh() {
    const res = await fetch('/api/acl?path=' + encodeURIComponent(cur.path));

    if (res.ok) {
      cur = await res.json();
      render();
    }
  }

  async function openAccessFor(path) {
    if (!path) return;

    try {
      const res = await fetch('/api/acl?path=' + encodeURIComponent(path));

      if (!res.ok) return; // not readable → nothing to show
      cur = await res.json();
      kindSel.value = 'user';
      document.getElementById('acl-value-wrap').classList.remove('hidden');
      aclCb.clear();
      render();
      backdrop.classList.remove('hidden');
      loadDir().then(() => aclCb.refresh());
    } catch (_) {
      /* best-effort */
    }
  }

  function close() {
    backdrop.classList.add('hidden');
  }

  async function post(body) {
    errEl.classList.add('hidden');

    const res = await fetch('/api/acl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const p = await res.json().catch(() => null);

      errEl.textContent = (p && p.error) || 'HTTP ' + res.status;
      errEl.classList.remove('hidden');

      return false;
    }

    await refresh();

    return true;
  }

  window.openAccessFor = openAccessFor;

  document.getElementById('btn-access')?.addEventListener('click', () => {
    if (currentFile) openAccessFor(currentFile.path);
  });
  document.getElementById('acl-close').addEventListener('click', close);
  document.getElementById('acl-close-x')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  kindSel.addEventListener('change', () => {
    document.getElementById('acl-value-wrap').classList.toggle('hidden', kindSel.value === '*');
    aclCb.refresh();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let principal;

    if (kindSel.value === '*') {
      principal = '*';
    } else {
      const v = aclCb.getValue();

      if (!v) return;
      principal = kindSel.value + ':' + (kindSel.value === 'user' ? v.toLowerCase() : v);
    }

    if (await post({ path: cur.path, action: 'grant', principal, level: levelSel.value })) {
      aclCb.clear();
      setStatus(t('aclSharedToast'), 'ok');
    }
  });

  grantsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.acl-revoke');

    if (btn && (await post({ path: cur.path, action: 'revoke', principal: btn.dataset.principal }))) {
      setStatus(t('aclRevokedToast'), 'ok');
    }
  });

  document.getElementById('acl-make-private').addEventListener('click', async () => {
    const mine = myPrincipal();

    if (mine && (await post({ path: cur.path, action: 'set_owner', principal: mine }))) {
      setStatus(t('aclNowPrivateToast'), 'ok');
    }
  });

  document.getElementById('acl-make-commons').addEventListener('click', async () => {
    // Destructive: removes the owner AND every grant of this doc → confirm first.
    const ok = await confirmDialog({
      title: t('aclMakeCommons'),
      message: t('aclMakeCommonsConfirm'),
      confirmLabel: t('aclMakeCommons'),
      destructive: true,
    });

    if (ok && (await post({ path: cur.path, action: 'make_commons' }))) {
      setStatus(t('aclNowCommonsToast'), 'ok');
    }
  });
})();
