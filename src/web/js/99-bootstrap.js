if (isServerMode) {
  fetch('/api/me').then(r => r.json()).then(data => {
    meState = data;
    // CSRF token: authoritative for all mutating requests (cf. fetch wrapper).
    if (data.csrf_token) setCsrfToken(data.csrf_token);
    if (typeof data.totp_enabled === 'boolean') totpEnabled = data.totp_enabled;
    if (data.cloud && data.authenticated && data.email) {
      const bar = document.getElementById('user-bar');
      document.getElementById('user-email').textContent = data.email;
      bar.classList.remove('hidden');
    }
    if (data.authenticated && data.role && data.role !== 'admin') {
      document.body.classList.add('viewer-mode');
      window.__viewerMode = true;
    }
    // Settings gear: reserved for admins in cloud mode (account/token
    // management only makes sense where auth is active). Locally the simulated
    // admin has no one to manage; so we don't expose the panel.
    if (data.cloud && data.authenticated && data.role === 'admin') {
      document.body.classList.add('admin-cloud');
    }
    // Security tab (2FA + sessions): any authenticated account in cloud mode,
    // admin OR viewer. Shown via the cloud-authed class (cf. CSS).
    if (data.cloud && data.authenticated) {
      document.body.classList.add('cloud-authed');
      refreshSecurityState();
    }
  }).catch(() => {});

  refresh();
  setInterval(refresh, 10000);

  // Soft reload: instead of location.reload(), we fetch /api/tree and update the DOM.
  async function softReload() {
    if (editMode) return;
    if (document.querySelector('.todo-edit')) return;
    if (!newFileBackdrop.classList.contains('hidden')) return;
    if (!qcBackdrop.classList.contains('hidden')) return;
    if (!shareBackdrop.classList.contains('hidden')) return;
    if (!dirRenameBackdrop.classList.contains('hidden')) return;
    // Extension modals ([data-atlas-modal]): same consideration as the native ones.
    if (document.querySelector('[data-atlas-modal]:not(.hidden)')) return;
    // Echo of an edit we just made ourselves (checkbox toggle): the viewer
    // already shows the right state, we skip this reload to avoid the flash
    // (the window extends on each toggle, then live-reload resumes).
    if (currentFile && _selfSaveUntil[currentFile.path] && Date.now() < _selfSaveUntil[currentFile.path]) return;
    try {
      const res = await fetch('/api/tree');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const newTree = await res.json();
      TREE.children = newTree.children;
      TREE.name = newTree.name;
      for (const k in fileMap) delete fileMap[k];
      mdCount = 0; otherCount = 0;
      index(TREE);
      statsEl.textContent = t('statsLine', mdCount, otherCount);
      const openDirs = new Set();
      treeEl.querySelectorAll('button').forEach(b => {
        const nameEl = b.querySelector('[data-name]');
        if (nameEl && b.querySelector('.caret.open')) openDirs.add(nameEl.dataset.name);
      });
      treeEl.innerHTML = '';
      treeEl.appendChild(renderTree(TREE));
      decorateTreeBadges();
      decorateRemoteOrigins();
      treeEl.querySelectorAll('button').forEach(b => {
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
          showWelcome();
        } else if (newFile.mtime !== currentFile.mtime) {
          contentCache.delete(newFile.path);
          newFile.content = null;
          const scrollPos = document.querySelector('main').scrollTop;
          await showMarkdown(newFile);
          document.querySelector('main').scrollTop = scrollPos;
        } else {
          currentFile = newFile;
        }
      } else {
        showWelcome();
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

  // Service worker: offline + instant loading (PWA). Cf. /sw.js. On deploy the new
  // SW (skipWaiting + clients.claim in sw.js) takes control → we reload ONCE to pick
  // up the fresh shell/assets, so an update never needs a manual unregister. We skip
  // the first-ever install (no prior controller) and never clobber an open editor —
  // a deferred update is retried when the tab regains focus.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    let _swReloading = false, _swUpdatePending = false, _swReg = null;
    const _hadController = !!navigator.serviceWorker.controller;
    const _reloadForUpdate = () => {
      if (_swReloading || document.getElementById('md-editor')) return;  // never interrupt an edit
      _swReloading = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!_hadController) return;     // first install: nothing to refresh
      _swUpdatePending = true;
      _reloadForUpdate();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (_swUpdatePending) _reloadForUpdate();   // retry a deferred update reload
      else if (_swReg) _swReg.update();           // catch a deploy made during a long session
    });
    window.addEventListener('load', () => {
      // updateViaCache:'none' → the SW script is always revalidated against the
      // network (server already sends Cache-Control:no-cache), so a new version is
      // detected promptly. reg.update() forces that check on each load.
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => { _swReg = reg; reg.update(); })
        .catch((e) => console.warn('SW register failed', e));
    });
  }
} else {
  // file:// mode: no server. If we have an EMBED_CONTENT, we can still read.
  // Otherwise (never in practice), we degrade.
  todoList.innerHTML = '<li class="px-3 py-4 text-center text-xs text-slate-500">' + t('fileModeTodosHtml') + '</li>';
  todoInput.disabled = true;
  todoForm.querySelector('button').disabled = true;
  setStatus(t('serverRequired'), 'err');
  newFileBtn.classList.add('hidden');
  qcBtn.classList.add('hidden');
}
