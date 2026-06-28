// New-file modal + the public window.Atlas extension API, and the cross-modal Escape-priority stack.
//
// Each modal shares one lifecycle (Modal, in ui/modal-base.ts): hidden-class toggle +
// click-outside-to-close; focus and field resets live in each subclass's open(). One module-level
// keydown handler owns the Escape-priority stack across EVERY modal — including ones other modules own
// (settings, quick-capture, share, rename) — plus the `n` new-file shortcut, so it stays a free handler,
// not a method.
//
// NewFileModal delegates its template <select> to a TemplateRegistry (template-registry.ts) and
// the folder-rename dialog lives in DirRenameModal (dir-rename-modal.ts); both are imported by this module.
//
// getAllDirs and refreshTreeOrReload are exported here and imported by consumers across modules —
// content/content-tree.ts, the admin/settings/ tabs, inbox/inbox.ts and the rename/dir-rename modals;
// module scope (not a shared global scope) keeps everything else private.

import { Modal } from '../ui/modal-base';
import { AtlasCombobox } from '../ui/combobox';
import { TREE } from '../core/data-csrf';
import { TemplateRegistry } from './template-registry';
import { DirRenameModal } from './dir-rename-modal';
import { t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { setStatus } from '../core/net';
import { currentFile, editMode } from '../core/state';
import { contentCache } from '../content/content-tree';
import { fileMap } from '../core/tree';
import { renameBackdrop, renameModal } from './dialogs';
import { shareBackdrop, closeShareModal } from '../admin/settings/settings-shared';
import { settingsPanel } from '../admin/settings/settings-panel';
import { quickCaptureModal } from './quick-capture';

// Cross-file refs read by boot/bootstrap.ts; HTMLElement | null, so consumers assert with `!`.
export const newFileBtn = document.getElementById('new-file-btn');
export const newFileBackdrop = document.getElementById('new-file-backdrop');
export const dirRenameBackdrop = document.getElementById('dir-rename-backdrop');

// Distinct folders under TREE, sorted — feeds the new-file and inbox folder comboboxes.
export function getAllDirs(): string[] {
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
export async function refreshTreeOrReload(): Promise<void> {
  if (window.softReload) await window.softReload();
  else location.reload();
}

export class NewFileModal extends Modal {
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

export const newFileModal = new NewFileModal();
export const dirRenameModal = new DirRenameModal();

// Extensions (inlined after this script by the Python build) register templates and drive the viewer here.
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

// One Escape-priority stack across every modal (some owned by other modules) + the `n` shortcut.
// Order: settings → new-file → dir-rename → quick-capture → share → rename.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // settings-panel.ts keeps its backdrop private, so probe the element rather than import a ref.
    const settingsBackdrop = document.getElementById('settings-backdrop');

    if (settingsBackdrop && !settingsBackdrop.classList.contains('hidden')) {
      settingsPanel.close();

      return;
    }

    if (newFileModal.isOpen()) {
      newFileModal.close();

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
      renameModal.close();

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
