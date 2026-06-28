// Boot + the SSE soft-reload. softReload re-fetches /api/tree, re-indexes fileMap, and re-renders
// the sidebar tree through the Atlas DOM runtime (contentTree.reload) — the keyed reconciler keeps
// the open folders (state) and the scroll offset, so no DOM-sniff / save-restore crutch is needed.
// The content branch (open doc / home / route) stays imperative until those modules migrate.
class Boot {
  private swReloading = false;
  private swUpdatePending = false;
  private swReg: ServiceWorkerRegistration | null = null;
  private hadController = false;

  start(): void {
    if (isServerMode) this.serverBoot();
    else this.fileBoot();
  }

  private serverBoot(): void {
    // Boot skeleton: in server mode the tree + content render only AFTER /api/me + /api/tree (the
    // baked tree is the owner's full view, never shown). Until then, a shimmer instead of a flash.
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
      .then((data: MeResponse) => {
        meState = data;
        if (data.authenticated) {
          // Authoritative CSRF token for all mutating requests (cf. the fetch wrapper).
          if (data.csrf_token) setCsrfToken(data.csrf_token);
          if (typeof data.totp_enabled === 'boolean') totpEnabled = data.totp_enabled;

          if (data.cloud && data.email) {
            document.getElementById('user-email')!.textContent = data.name || data.email;
            const avatar = document.getElementById('user-avatar');

            if (avatar) avatar.innerHTML = constellationSvg(avatarSeed(data.first_name, data.last_name, data.email), 30);
            document.getElementById('user-bar')!.classList.remove('hidden');
          }
          // Member (non-admin): viewer-mode class (CSS hides the Todos widget); per-doc authorization
          // is enforced server-side. The write affordances stay (a disallowed action gets a clean 403).
          if (data.role && data.role !== 'admin') document.body.classList.add('viewer-mode');
          // Settings gear: cloud admins only.
          if (data.cloud && data.role === 'admin') document.body.classList.add('admin-cloud');
          // Security tab (2FA + sessions): any authenticated cloud account.
          if (data.cloud) {
            document.body.classList.add('cloud-authed');
            refreshSecurityState();
          }
        }
        // Render the per-account FILTERED tree (the baked tree is the full build-time view).
        this.softReload();
      })
      .catch((e) => {
        // Don't strand the boot skeleton on a transient /api/me blip: log it and load the tree anyway.
        console.warn('boot /api/me failed:', e);
        this.softReload();
      });

    refresh();
    // Poll the todos widget every 10s. Content/tree live-reload is the SSE below (no fallback poll).
    setInterval(refresh, 10000);

    window.softReload = () => this.softReload();
    this.setupSse();
    this.setupServiceWorker();
  }

  private fileBoot(): void {
    // file:// mode: no server. Reading still works via EMBED_CONTENT.
    todoList!.innerHTML = '<li class="px-3 py-4 text-center text-xs text-slate-500">' + t('fileModeTodosHtml') + '</li>';
    (todoInput as HTMLInputElement).disabled = true;
    (todoForm!.querySelector('button') as HTMLButtonElement).disabled = true;
    setStatus(t('serverRequired'), 'err');
    newFileBtn!.classList.add('hidden');
    qcBtn!.classList.add('hidden');
  }

  // Bail conditions for a live-reload: anything the user is mid-action on that a re-render would
  // clobber. Pure business POLICY (no DOM-destruction crutch — the runtime handles that). Checked
  // BOTH before the fetch AND after the await (the SSE 'reload' fires exactly when a doc changed,
  // so an Edit started during the network RTT must still abort the stale reload).
  private shouldAbortReload(): boolean {
    if (editMode) return true;
    if (document.querySelector('.todo-edit')) return true;
    if (!newFileBackdrop!.classList.contains('hidden')) return true;
    if (!qcBackdrop!.classList.contains('hidden')) return true;
    if (!shareBackdrop!.classList.contains('hidden')) return true;
    if (!dirRenameBackdrop!.classList.contains('hidden')) return true;
    if (document.querySelector('[data-atlas-modal]:not(.hidden)')) return true;
    // Echo of an edit we just made (checkbox toggle): skip to avoid a flash.
    if (currentFile && sse.isSelfSaveMuted(currentFile.path)) return true;

    return false;
  }

  async softReload(): Promise<void> {
    if (this.shouldAbortReload()) return;

    try {
      const res = await fetch('/api/tree');

      if (!res.ok) throw new Error('HTTP ' + res.status);

      const newTree = await res.json();

      if (this.shouldAbortReload()) return; // re-check post-await: the user may have started editing

      TREE.children = newTree.children;
      TREE.name = newTree.name;

      for (const k in fileMap) delete fileMap[k];
      mdCount = 0;
      otherCount = 0;
      index(TREE);
      statsEl.textContent = t('statsLine', mdCount, otherCount);

      // The sidebar tree, rendered through the runtime: open folders (state) + scroll survive.
      contentTree.reload();
      decorateTreeBadges();
      contentTree.decorateRemoteOrigins();
      renderRecent();

      // Invalidate the lazy indexes: content / backlinks / search / wikilink maps may have changed.
      backlinksIndex = null;
      backlinksLoading = null;
      miniSearch = null;
      searchInitPromise = null;
      _wlMaps = null;

      if (currentFile) {
        const newFile = fileMap[currentFile.path];

        if (!newFile) {
          // The open doc is gone from the viewer's filtered tree → clean not-found, not a home bounce.
          showNotFound(currentFile.path);
        } else if (newFile.mtime !== currentFile.mtime) {
          // Re-fetch the open doc; save/restore main's scroll around the (still-imperative) re-render.
          contentCache.delete(newFile.path);
          newFile.content = undefined;
          const main = document.querySelector('main')!;
          const scrollPos = main.scrollTop;

          await showMarkdown(newFile);
          main.scrollTop = scrollPos;
        } else {
          currentFile = newFile;
        }
      } else if (document.getElementById('home-activity-mount') && window.refreshActivityData) {
        // Home on screen: do NOT re-render it (that re-mounts the activity card and wipes its open
        // inbox editor / poll). The tree is already patched; refresh only the active tab's data.
        window.refreshActivityData();
      } else {
        // First load / not-found page: (re-)route from the hash now fileMap reflects accessible docs.
        const main = document.querySelector('main')!;
        const sp = main.scrollTop;

        routeFromHash();
        main.scrollTop = sp;
      }
    } catch (e) {
      // A transient /api/tree hiccup must NOT nuke the page: the SSE fires right when the server is
      // busy writing, so a blip would destroy the state this soft path protects. Skip; the next retries.
      console.warn('softReload skipped (transient):', e);
    }
  }

  private setupSse(): void {
    try {
      const es = new EventSource('/api/events');

      es.addEventListener('message', (e) => {
        if (e.data === 'reload') this.softReload();
      });
    } catch (e) {
      console.warn('SSE live-reload unavailable:', e);
    }
  }

  // Service worker (offline + instant-loading PWA). On deploy the new SW takes control → reload ONCE
  // for fresh assets. Skip the first install, never clobber an open editor (deferred update retried
  // when the tab regains focus).
  private setupServiceWorker(): void {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
    this.hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!this.hadController) return; // first install: nothing to refresh
      this.swUpdatePending = true;
      this.reloadForUpdate();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.swUpdatePending) this.reloadForUpdate();
      else if (this.swReg) this.swReg.update();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          this.swReg = reg;
          reg.update();
        })
        .catch((e) => console.warn('SW register failed', e));
    });
  }

  private reloadForUpdate(): void {
    if (this.swReloading || document.getElementById('md-editor')) return; // never interrupt an edit
    this.swReloading = true;
    location.reload();
  }
}

new Boot().start();
