// ── Access & sharing (model B per-document ACL) ──────────────────────────────
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

  function fillDatalist() {
    const dl = document.getElementById('acl-value-list');
    if (!dl || !dir) return;
    const items = kindSel.value === 'group' ? dir.groups || [] : dir.users || [];
    dl.innerHTML = items.map((v) => '<option value="' + escapeHtml(v) + '"></option>').join('');
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
      valueInp.classList.remove('hidden');
      valueInp.value = '';
      render();
      backdrop.classList.remove('hidden');
      loadDir().then(fillDatalist);
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
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  kindSel.addEventListener('change', () => {
    valueInp.classList.toggle('hidden', kindSel.value === '*');
    fillDatalist();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let principal;

    if (kindSel.value === '*') {
      principal = '*';
    } else {
      const v = valueInp.value.trim();

      if (!v) return;
      principal = kindSel.value + ':' + (kindSel.value === 'user' ? v.toLowerCase() : v);
    }

    if (await post({ path: cur.path, action: 'grant', principal, level: levelSel.value })) {
      valueInp.value = '';
    }
  });

  grantsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.acl-revoke');

    if (btn) await post({ path: cur.path, action: 'revoke', principal: btn.dataset.principal });
  });

  document.getElementById('acl-make-private').addEventListener('click', async () => {
    const mine = myPrincipal();

    if (mine) await post({ path: cur.path, action: 'set_owner', principal: mine });
  });

  document.getElementById('acl-make-commons').addEventListener('click', async () => {
    await post({ path: cur.path, action: 'make_commons' });
  });
})();
