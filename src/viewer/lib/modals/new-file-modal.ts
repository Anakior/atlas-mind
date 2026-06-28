// New-file modal + the public window.Atlas extension API, and the cross-modal Escape-priority stack.
//
// Each modal shares one lifecycle (Modal, in 01c-modal-base.ts): hidden-class toggle +
// click-outside-to-close; focus and field resets live in each subclass's open(). One module-level
// keydown handler owns the Escape-priority stack across EVERY modal — including ones other modules own
// (settings, quick-capture, share, rename) — plus the `n` new-file shortcut, so it stays a free handler,
// not a method.
//
// NewFileModal delegates its template <select> to a TemplateRegistry (19-a-template-registry.ts) and
// the folder-rename dialog lives in DirRenameModal (19-b-dir-rename.ts); both concat before this file
// so their classes exist when the modals are constructed at module init below.
//
// getAllDirs / refreshTreeOrReload / openNewFileModal / closeNewFileModal / openDirRenameModal stay
// free globals: cross-module consumers (02-content-tree, 13-todos, 14-dialogs, 16-settings,
// 22-inbox) read them by name in the shared scope.

// Cross-file refs read by 99-bootstrap.ts; HTMLElement | null, so consumers assert with `!`.
const newFileBtn = document.getElementById('new-file-btn');
const newFileBackdrop = document.getElementById('new-file-backdrop');
const dirRenameBackdrop = document.getElementById('dir-rename-backdrop');

// Distinct folders under TREE, sorted — feeds the new-file and inbox folder comboboxes.
function getAllDirs(): string[] {
  const dirs = new Set<string>();

  (function walk(node: TreeNode, prefix: string): void {
    const children = node.type === 'dir' ? node.children : [];

    for (const c of children) {
      if (c.type === 'dir') {
        const path = prefix ? prefix + '/' + c.name : c.name;

        dirs.add(path);
        walk(c, path);
      }
    }
  })(TREE, '');

  return Array.from(dirs).sort();
}

// After a write: refresh the tree in place (SSE soft-reload) or fall back to a full reload.
async function refreshTreeOrReload(): Promise<void> {
  if (window.softReload) await window.softReload();
  else location.reload();
}

class NewFileModal extends Modal {
  private readonly form = document.getElementById('new-file-form') as HTMLFormElement;
  private readonly dir = document.getElementById('new-file-dir') as HTMLInputElement;
  private readonly name = document.getElementById('new-file-name') as HTMLInputElement;
  private readonly template = document.getElementById('new-file-template') as HTMLSelectElement;
  private readonly visibility = document.getElementById('new-file-visibility') as HTMLSelectElement | null;
  private readonly error = document.getElementById('new-file-error') as HTMLElement;
  private readonly cancel = document.getElementById('new-file-cancel') as HTMLElement;
  // The template <select> — its options, extension providers and content fill — is delegated here.
  private readonly registry: TemplateRegistry;

  constructor() {
    super(newFileBackdrop!);
    // Created once, lives for the page's lifetime (no teardown — the modal is never destroyed).
    AtlasCombobox(this.dir, { source: getAllDirs, creatable: true });
    this.registry = new TemplateRegistry(this.template, this.name, this.dir);
    newFileBtn!.addEventListener('click', () => this.open());
    this.cancel.addEventListener('click', () => this.close());
    document.getElementById('new-file-close')?.addEventListener('click', () => this.close());
    this.template.addEventListener('change', () => this.registry.updateExtras());
    this.form.addEventListener('submit', (e) => this.submit(e));
  }

  // window.Atlas.registerTemplate — delegated to the template registry.
  registerTemplate(value: string, provider: TemplateProvider): boolean {
    return this.registry.registerTemplate(value, provider);
  }

  open(presetDir?: string): void {
    if (window.__viewerMode) return;
    this.error.classList.add('hidden');
    this.dir.value = presetDir || '';
    this.name.value = '';
    this.template.value = 'blank';

    if (this.visibility) {
      // Default PRIVATE (Notion sense), pre-set to the user's last choice. A doc created inside a
      // private folder is private regardless (the server enforces it).
      this.visibility.value =
        localStorage.getItem('atlas:newdoc-visibility') === 'commons' ? 'commons' : 'private';
    }

    this.registry.runOpenHooks();
    this.registry.updateExtras();
    this.reveal();
    setTimeout(() => (presetDir ? this.name : this.dir).focus(), 50);
  }

  private showError(msg: string): void {
    this.error.textContent = msg;
    this.error.classList.remove('hidden');
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.classList.add('hidden');
    const dir = this.dir.value.trim().replace(/^\/+|\/+$/g, '');
    let name = this.name.value.trim();
    const provider = this.registry.activeProvider();
    let content!: string; // assigned in both the provider and the !provider branch below

    if (provider) {
      // The extension generator produces the content (+ a fallback slug). A thrown error is the user message.
      try {
        const built = await provider.generate();

        content = built.content;

        if (!name) name = (built.slug || '').trim();
      } catch (err) {
        return this.showError((err as Error).message);
      }
    }

    if (!name) return this.showError(t('nameRequired'));

    if (/[\\\/]/.test(name)) return this.showError(t('noSlashes'));

    if (!name.endsWith('.md')) name += '.md';
    const path = dir ? dir + '/' + name : name;

    if (fileMap[path]) return this.showError(t('fileExists'));

    if (!provider) {
      const title = name
        .replace(/\.md$/, '')
        .replace(/[-_]/g, ' ')
        .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());

      content = TemplateRegistry.buildContent(this.template.value, title);
    }

    const visibility = this.visibility ? this.visibility.value : 'private';

    try {
      localStorage.setItem('atlas:newdoc-visibility', visibility);
    } catch (_) {
      /* ignore */
    }

    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, private: visibility === 'private' }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.close();
      location.hash = '#' + encodeURIComponent(path);
      setStatus((provider && provider.successMessage) || t('docCreated'), 'ok');
      await refreshTreeOrReload();
    } catch (err) {
      this.showError(t('errSp', (err as Error).message));
    }
  }
}

const newFileModal = new NewFileModal();
const dirRenameModal = new DirRenameModal();

// Extensions (inlined after this script by build.py) register templates and drive the viewer here.
window.Atlas = {
  version: 1,
  t,
  escapeHtml,
  setStatus,
  refresh: refreshTreeOrReload,
  currentDoc() {
    return currentFile ? { path: currentFile.path } : null;
  },
  invalidateDoc(path: string): void {
    contentCache.delete(path);

    if (currentFile && currentFile.path === path) {
      currentFile.content = undefined;
      currentFile.mtime = 0;
    }
  },
  registerTemplate(value: string, provider: TemplateProvider): boolean {
    return newFileModal.registerTemplate(value, provider);
  },
};

// Public new-file/dir-rename entry points kept as globals (read by 02-content-tree.ts and others).
function openNewFileModal(presetDir?: string): void {
  newFileModal.open(presetDir);
}

function closeNewFileModal(): void {
  newFileModal.close();
}

function openDirRenameModal(path: string): void {
  dirRenameModal.open(path);
}

// One Escape-priority stack across every modal (some owned by other modules) + the `n` shortcut.
// Order: settings → new-file → dir-rename → quick-capture → share → rename.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // 16-settings owns the backdrop privately now, so probe the element rather than a global ref.
    const settingsBackdrop = document.getElementById('settings-backdrop');

    if (settingsBackdrop && !settingsBackdrop.classList.contains('hidden')) {
      closeSettings();

      return;
    }

    if (newFileModal.isOpen()) {
      closeNewFileModal();

      return;
    }

    if (dirRenameModal.isOpen()) {
      dirRenameModal.close();

      return;
    }

    if (quickCaptureModal.isOpen()) {
      quickCaptureModal.close();

      return;
    }

    if (!shareBackdrop.classList.contains('hidden')) {
      closeShareModal();

      return;
    }

    if (!renameBackdrop!.classList.contains('hidden')) {
      closeRenameModal();

      return;
    }
  }

  if (
    e.key === 'n' &&
    !window.__viewerMode &&
    !editMode &&
    !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')
  ) {
    e.preventDefault();
    newFileModal.open();
  }
});
