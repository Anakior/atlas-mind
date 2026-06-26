if (isServerMode) {
  // Boot skeleton: in server mode the sidebar tree + content render only AFTER /api/me +
  // /api/tree (the baked tree is the owner's full view, never shown, privacy). Until
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
        // Member (non-admin): keep the viewer-mode class (the CSS hides only the global Todos widget)
        // but NOT the __viewerMode flag, so the write affordances stay; per-doc authorization is
        // enforced server-side (a disallowed action just gets a clean 403/404).
        document.body.classList.add('viewer-mode');
        window.__isMember = true;
      }

      // Settings gear: cloud admins only; account/token management is moot
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
    .catch((e) => {
      // Don't strand the boot skeleton on a transient /api/me blip: log it and load the tree anyway,
      // so the user gets content instead of a frozen shimmer forever.
      console.warn('boot /api/me failed:', e);
      softReload();
    });

  refresh();
  // Poll the todos widget every 10s. The content/tree live-reload is the SSE below (no fallback poll).
  setInterval(refresh, 10000);

  // Bail conditions for a live-reload: anything the user is mid-action on that a DOM rebuild would
  // clobber. Checked BOTH before the fetch AND again after the await: the SSE 'reload' fires exactly
  // when a doc changed, so an Edit started during the network RTT must still abort the stale reload
  // (the TOCTOU that let showMarkdown overwrite a freshly-opened editor).
  function shouldAbortReload() {
    if (editMode) return true;
    if (document.querySelector('.todo-edit')) return true;
    if (!newFileBackdrop.classList.contains('hidden')) return true;
    if (!qcBackdrop.classList.contains('hidden')) return true;
    if (!shareBackdrop.classList.contains('hidden')) return true;
    if (!dirRenameBackdrop.classList.contains('hidden')) return true;
    // Extension modals ([data-atlas-modal]): same consideration as the native ones.
    if (document.querySelector('[data-atlas-modal]:not(.hidden)')) return true;
    // Echo of an edit we just made ourselves (checkbox toggle): skip to avoid a flash.
    if (currentFile && _selfSaveUntil[currentFile.path] && Date.now() < _selfSaveUntil[currentFile.path]) return true;
    return false;
  }

  // Soft reload: fetch /api/tree and patch the DOM in place instead of location.reload().
  async function softReload() {
    if (shouldAbortReload()) return;

    try {
      const res = await fetch('/api/tree');

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const newTree = await res.json();
      if (shouldAbortReload()) return;  // re-check post-await: the user may have started editing during the RTT

      TREE.children = newTree.children;
      TREE.name = newTree.name;

      for (const k in fileMap) delete fileMap[k];
      mdCount = 0;
      otherCount = 0;
      index(TREE);
      statsEl.textContent = t('statsLine', mdCount, otherCount);
      const openDirs = new Set();

      // Key the open/closed state on the full dir path, not the basename, so two same-named folders
      // under different parents don't share it (opening one would re-open the other after a reload).
      treeEl.querySelectorAll('button[data-dir-path]').forEach((b) => {
        if (b.querySelector('.caret.open')) openDirs.add(b.dataset.dirPath);
      });
      treeEl.innerHTML = '';
      treeEl.appendChild(renderTree(TREE));
      decorateTreeBadges();
      decorateRemoteOrigins();
      treeEl.querySelectorAll('button[data-dir-path]').forEach((b) => {
        if (openDirs.has(b.dataset.dirPath)) {
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
      // A transient /api/tree fetch/parse hiccup must NOT nuke the page: the SSE fires right when the
      // server is busy writing, so a blip here would destroy the very state this soft path protects
      // (an open editor, the inbox focus + poll). Skip this cycle; the next SSE event / reconnect retries.
      console.warn('softReload skipped (transient):', e);
    }
  }

  window.softReload = softReload;

  try {
    const es = new EventSource('/api/events');

    es.addEventListener('message', (e) => {
      if (e.data === 'reload') softReload();
    });
  } catch (e) { console.warn('SSE live-reload unavailable:', e); }

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
