if (isServerMode) {
  // Boot skeleton: in server mode the sidebar tree + content render only AFTER /api/me +
  // /api/tree (the baked tree is the owner's full view, never shown — privacy). Until
  // then, show a shimmer skeleton instead of a flash of empty menu/home. softReload()
  // (called once /api/tree lands) replaces it with the real tree + route.
  treeEl.innerHTML = Array.from({ length: 7 }, (_, i) =>
    `<div class="skeleton" style="height:1rem;margin:.55rem .5rem;width:${55 + ((i * 17) % 40)}%"></div>`).join('');
  contentEl.innerHTML =
    '<div class="not-prose" style="max-width:46rem;margin:0 auto;padding-top:2.5rem">' +
    '<div class="skeleton-title" style="height:2.2rem;width:55%;margin-bottom:1.6rem"></div>' +
    Array.from({ length: 6 }, (_, i) =>
      `<div class="skeleton" style="height:.9rem;margin:.7rem 0;width:${70 + ((i * 13) % 26)}%"></div>`).join('') +
    '</div>';

  fetch('/api/me')
    .then((r) => r.json())
    .then((data) => {
      meState = data;

      // Authoritative CSRF token for all mutating requests (cf. fetch wrapper).
      if (data.csrf_token) setCsrfToken(data.csrf_token);

      if (typeof data.totp_enabled === 'boolean') totpEnabled = data.totp_enabled;

      if (data.cloud && data.authenticated && data.email) {
        const bar = document.getElementById('user-bar');

        document.getElementById('user-email').textContent = data.name || data.email;
        const avatar = document.getElementById('user-avatar');
        if (avatar) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 30);
        bar.classList.remove('hidden');
      }

      if (data.authenticated && data.role && data.role !== 'admin') {
        // Member (non-admin): may write its OWN docs — the server enforces per
        // document. We KEEP the `viewer-mode` class (CSS now hides only the
        // still-global Todos widget) but do NOT set the __viewerMode flag, so the
        // write affordances (create/edit/delete/move/share/rename) are available;
        // disallowed actions fail with a clean 403/404 from the backend. Notes
        // (comment level) stay admin-only via the class check.
        document.body.classList.add('viewer-mode');
        window.__isMember = true;
      }

      // Settings gear: cloud admins only — account/token management is moot
      // without active auth, and the local simulated admin has no one to manage.
      if (data.cloud && data.authenticated && data.role === 'admin') {
        document.body.classList.add('admin-cloud');
      }

      // Security tab (2FA + sessions): any authenticated cloud account, admin OR viewer.
      if (data.cloud && data.authenticated) {
        document.body.classList.add('cloud-authed');
        refreshSecurityState();
      }

      // Render the per-account FILTERED tree (the baked tree is the full
      // build-time view and is intentionally not shown in server mode).
      softReload();
    })
    .catch(() => {});

  refresh();
  // Live-reload heartbeat. softReload() is now non-destructive on the home (it refreshes only the
  // active activity tab in place, never re-mounting the card), so this no longer wipes an open inbox
  // editor; see the refreshActivityData() branch in softReload().
  setInterval(refresh, 10000);

  // Soft reload: fetch /api/tree and patch the DOM in place instead of location.reload().
  async function softReload() {
    if (editMode) return;

    if (document.querySelector('.todo-edit')) return;

    if (!newFileBackdrop.classList.contains('hidden')) return;

    if (!qcBackdrop.classList.contains('hidden')) return;

    if (!shareBackdrop.classList.contains('hidden')) return;

    if (!dirRenameBackdrop.classList.contains('hidden')) return;

    // Extension modals ([data-atlas-modal]): same consideration as the native ones.
    if (document.querySelector('[data-atlas-modal]:not(.hidden)')) return;

    // Skip the echo of an edit we just made ourselves (checkbox toggle) to avoid a
    // flash; the window extends on each toggle, then live-reload resumes.
    if (
      currentFile &&
      _selfSaveUntil[currentFile.path] &&
      Date.now() < _selfSaveUntil[currentFile.path]
    )
      return;

    try {
      const res = await fetch('/api/tree');

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const newTree = await res.json();

      TREE.children = newTree.children;
      TREE.name = newTree.name;

      for (const k in fileMap) delete fileMap[k];
      mdCount = 0;
      otherCount = 0;
      index(TREE);
      statsEl.textContent = t('statsLine', mdCount, otherCount);
      const openDirs = new Set();

      treeEl.querySelectorAll('button').forEach((b) => {
        const nameEl = b.querySelector('[data-name]');

        if (nameEl && b.querySelector('.caret.open')) openDirs.add(nameEl.dataset.name);
      });
      treeEl.innerHTML = '';
      treeEl.appendChild(renderTree(TREE));
      decorateTreeBadges();
      decorateRemoteOrigins();
      treeEl.querySelectorAll('button').forEach((b) => {
        const nameEl = b.querySelector('[data-name]');

        if (nameEl && openDirs.has(nameEl.dataset.name)) {
          b.querySelector('.caret').classList.add('open');
          const ul = b.parentElement.querySelector('ul');

          if (ul) ul.classList.remove('hidden');
        }
      });
      renderRecent();
      // Invalidate the lazy indexes: the content / backlinks may have changed.
      backlinksIndex = null;
      backlinksLoading = null;
      miniSearch = null;
      searchInitPromise = null;

      // If a file is open, re-fetch its content if the mtime changed.
      if (currentFile) {
        const newFile = fileMap[currentFile.path];

        if (!newFile) {
          // The open doc is no longer in the viewer's filtered tree → no access /
          // gone. Show the clean not-found page, not a silent bounce to home.
          showNotFound(currentFile.path);
        } else if (newFile.mtime !== currentFile.mtime) {
          contentCache.delete(newFile.path);
          newFile.content = null;
          const scrollPos = document.querySelector('main').scrollTop;

          await showMarkdown(newFile);
          document.querySelector('main').scrollTop = scrollPos;
        } else {
          currentFile = newFile;
        }
      } else if (document.getElementById('home-activity-mount') && window.refreshActivityData) {
        // Home already on screen: do NOT re-render it. Re-rendering re-mounts the activity card and
        // wipes whatever its active tab is doing (an open inbox folder/tag editor, the inbox poll).
        // The tree above is already patched; refresh only the active activity tab's data in place.
        window.refreshActivityData();
      } else {
        // No doc open and the home isn't up yet (first load), or we're on the not-found page:
        // (re-)route from the URL hash now that fileMap reflects the viewer's accessible docs, so a
        // link to a doc they can't see lands on the clean not-found page instead of bouncing home.
        // Preserve scroll so a live re-render doesn't jump to the top under you.
        const sp = document.querySelector('main').scrollTop;
        routeFromHash();
        document.querySelector('main').scrollTop = sp;
      }
    } catch (e) {
      console.warn('softReload failed, fallback to location.reload', e);
      location.reload();
    }
  }

  window.softReload = softReload;

  try {
    const es = new EventSource('/api/events');

    es.addEventListener('message', (e) => {
       if (e.data === 'reload') softReload();
    });
    es.addEventListener('error', () => {});
  } catch (e) {}

  // Service worker (offline + instant loading PWA, cf. /sw.js). On deploy the new
  // SW takes control → reload ONCE to pick up fresh assets (no manual unregister).
  // Skip the first-ever install, never clobber an open editor (deferred update
  // retried when the tab regains focus).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    let _swReloading = false,
      _swUpdatePending = false,
      _swReg = null;
    const _hadController = !!navigator.serviceWorker.controller;
    const _reloadForUpdate = () => {
      if (_swReloading || document.getElementById('md-editor')) return; // never interrupt an edit
      _swReloading = true;
      location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!_hadController) return; // first install: nothing to refresh
      _swUpdatePending = true;
      _reloadForUpdate();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;

      if (_swUpdatePending)
        _reloadForUpdate(); // retry a deferred update reload
      else if (_swReg) _swReg.update(); // catch a deploy made during a long session
    });
    window.addEventListener('load', () => {
      // updateViaCache:'none' → the SW script is always revalidated against the
      // network, so a new version is detected promptly; reg.update() forces that check.
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          _swReg = reg;
          reg.update();
        })
        .catch((e) => console.warn('SW register failed', e));
    });
  }
} else {
  // file:// mode: no server. Reading still works via EMBED_CONTENT.
  todoList.innerHTML =
    '<li class="px-3 py-4 text-center text-xs text-slate-500">' + t('fileModeTodosHtml') + '</li>';
  todoInput.disabled = true;
  todoForm.querySelector('button').disabled = true;
  setStatus(t('serverRequired'), 'err');
  newFileBtn.classList.add('hidden');
  qcBtn.classList.add('hidden');
}
