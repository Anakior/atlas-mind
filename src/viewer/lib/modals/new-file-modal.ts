// New-file modal + the public window.Atlas extension API, and the cross-modal Escape-priority stack.
//
// Each modal shares one lifecycle (Modal, in ui/modal-base.ts): hidden-class toggle +
// click-outside-to-close; focus and field resets live in each subclass's open(). One module-level
// keydown handler owns the Escape-priority stack across EVERY modal — including ones other modules own
// (settings, share, rename) — plus the `n` new-file shortcut, so it stays a free handler, not a method.
// Quick capture is now a MODE of this modal (a tab in the new-file dialog), not a separate modal.
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
import { escapeHtml, slugify } from '../core/utils';
import { setStatus } from '../core/net';
import { currentFile, editMode } from '../core/state';
import { contentCache } from '../content/content-tree';
import { fileMap } from '../core/tree';
import { renameBackdrop, renameModal } from './dialogs';
import { shareBackdrop, closeShareModal } from '../admin/settings/settings-shared';
import { settingsPanel } from '../admin/settings/settings-panel';
import { sendToFolder } from '../content/file-drop';
import { docRenderer } from '../content/doc-renderer';
import { editor } from '../editor/editor';

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

export async function deleteEmptyFolder(path: string): Promise<void> {
  const res = await fetch('/api/dir', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  if (!res.ok) {
    setStatus(t(res.status === 409 ? 'folderNotEmpty' : 'folderDeleteFailed'), 'err');

    return;
  }
  await refreshTreeOrReload();
  setStatus(t('folderDeleted'), 'ok');
}

export class NewFileModal extends Modal {
  private readonly form = document.getElementById('new-file-form') as HTMLFormElement;
  private readonly dir = document.getElementById('new-file-dir') as HTMLInputElement;
  // The title: the file is named after it.
  private readonly name = document.getElementById('new-file-name') as HTMLInputElement;
  private readonly pathEl = document.getElementById('new-file-path') as HTMLElement;
  private readonly cards = document.getElementById('new-file-cards') as HTMLElement;
  private readonly uploadBtn = document.getElementById('new-file-upload') as HTMLElement;
  private readonly uploadInput = document.getElementById('new-file-upload-input') as HTMLInputElement;
  private readonly template = document.getElementById('new-file-template') as HTMLSelectElement;
  private readonly visibility = document.getElementById('new-file-visibility') as HTMLSelectElement | null;
  private readonly error = document.getElementById('new-file-error') as HTMLElement;
  private readonly cancel = document.getElementById('new-file-cancel') as HTMLElement;
  // The template <select> — its options, extension providers and content fill — is delegated here.
  private readonly registry: TemplateRegistry;

  // Mode toggle: a full document, or a quick capture dropped straight into the inbox.
  private readonly titleEl = document.getElementById('new-file-title') as HTMLElement;
  private readonly submitBtn = document.getElementById('new-file-submit') as HTMLElement;
  private readonly docFields = document.getElementById('new-file-doc-fields') as HTMLElement;
  private readonly captureFields = document.getElementById('new-file-capture-fields') as HTMLElement;
  private readonly modeDocBtn = document.getElementById('new-file-mode-doc') as HTMLElement;
  private readonly modeCaptureBtn = document.getElementById('new-file-mode-capture') as HTMLElement;
  private readonly modeFolderBtn = document.getElementById('new-file-mode-folder') as HTMLElement;
  private readonly nameLabel = document.getElementById('new-file-name-label') as HTMLElement;
  private readonly dirLabel = document.getElementById('new-file-dir-label') as HTMLElement;
  private readonly tip = document.getElementById('new-file-tip') as HTMLElement;
  private readonly extArea = document.getElementById('new-file-ext-area') as HTMLElement;
  private readonly captureTitle = document.getElementById('new-file-capture-title') as HTMLInputElement;
  private readonly captureBody = document.getElementById('new-file-capture-body') as HTMLTextAreaElement;
  private mode: 'doc' | 'folder' | 'capture' = 'doc';

  constructor() {
    super(newFileBackdrop!);
    // Created once, lives for the page's lifetime (no teardown — the modal is never destroyed).
    AtlasCombobox(this.dir, { source: getAllDirs, creatable: true });
    this.registry = new TemplateRegistry(this.template, this.name, this.dir);
    newFileBtn!.addEventListener('click', () => this.open());
    this.cancel.addEventListener('click', () => this.close());
    document.getElementById('new-file-close')?.addEventListener('click', () => this.close());
    this.template.addEventListener('change', () => {
      this.registry.updateExtras();
      this.renderCards();
    });
    this.name.addEventListener('input', () => this.showPath());
    this.dir.addEventListener('input', () => this.showPath());
    this.uploadBtn.addEventListener('click', () => this.uploadInput.click());
    this.uploadInput.addEventListener('change', () => {
      const files = Array.from(this.uploadInput.files || []);

      this.uploadInput.value = '';
      if (!files.length) return;
      this.close();
      sendToFolder(files, this.folder() ? this.folder() + '/' : '');
    });
    this.modeDocBtn.addEventListener('click', () => { this.setMode('doc'); this.dir.focus(); });
    this.modeCaptureBtn.addEventListener('click', () => { this.setMode('capture'); this.captureTitle.focus(); });
    this.modeFolderBtn.addEventListener('click', () => { this.setMode('folder'); this.name.focus(); });
    this.form.addEventListener('submit', (e) => this.submit(e));
  }

  // Focus is the caller's job.
  private setMode(m: 'doc' | 'folder' | 'capture'): void {
    this.mode = m;

    const capture = m === 'capture';
    const folder = m === 'folder';

    this.modeDocBtn.classList.toggle('active', m === 'doc');
    this.modeFolderBtn.classList.toggle('active', folder);
    this.modeCaptureBtn.classList.toggle('active', capture);
    this.docFields.classList.toggle('hidden', capture);
    this.captureFields.classList.toggle('hidden', !capture);
    for (const el of [this.cards, this.extArea, this.tip]) el.classList.toggle('hidden', folder);
    this.uploadBtn.classList.toggle('hidden', m !== 'doc');
    this.nameLabel.textContent = t(folder ? 'folderNameLabel' : 'titleLabel');
    this.dirLabel.textContent = t(folder ? 'inFolderLabel' : 'folderLabel');
    this.name.placeholder = t(folder ? 'folderNamePlaceholder' : 'docNamePlaceholder');
    this.titleEl.textContent = capture ? t('quickCaptureTitle') : t(folder ? 'newFolderHeader' : 'newDocHeader');
    this.submitBtn.textContent = capture ? t('save') : t('create');
    this.error.classList.add('hidden');
    this.showPath();
  }

  // window.Atlas.registerTemplate — delegated to the template registry.
  registerTemplate(value: string, provider: TemplateProvider): boolean {
    return this.registry.registerTemplate(value, provider);
  }

  open(presetDir?: string): void {
    if (window.__viewerMode) return;
    this.error.classList.add('hidden');
    // Where you are: the open doc's folder, unless it is a mirror of another atlas (read-only).
    const here = currentFile && !currentFile.path.startsWith('remotes/') ? currentFile.path : '';

    this.dir.value = presetDir ?? here.slice(0, Math.max(here.lastIndexOf('/'), 0));
    this.name.value = '';
    this.template.value = 'blank';
    this.captureTitle.value = '';
    this.captureBody.value = '';
    this.setMode('doc'); // every open starts on the document tab

    if (this.visibility) {
      // Default PRIVATE (Notion sense), pre-set to the user's last choice. A doc created inside a
      // private folder is private regardless (the server enforces it).
      this.visibility.value =
        localStorage.getItem('atlas:newdoc-visibility') === 'commons' ? 'commons' : 'private';
    }

    this.registry.runOpenHooks();
    this.registry.updateExtras();
    this.renderCards();
    this.showPath();
    this.reveal();
    setTimeout(() => this.name.focus(), 50);
  }

  private folder(): string {
    return this.dir.value.trim().replace(/^\/+|\/+$/g, '');
  }

  // The path the title gives, numbered when it is taken ("idee-2.md").
  private pathFor(title: string): string {
    const base = (this.folder() ? this.folder() + '/' : '') + (slugify(title) || 'note');
    let path = base + '.md';

    for (let n = 2; fileMap[path]; n++) path = base + '-' + n + '.md';

    return path;
  }

  private showPath(): void {
    const title = this.name.value.trim();

    if (this.mode === 'folder') this.pathEl.textContent = title ? this.folderPath() + '/' : '';
    else this.pathEl.textContent = title ? this.pathFor(title) : '';
  }

  // Not slugified: the tree shows a folder's name as typed.
  private folderPath(): string {
    const name = this.name.value.trim().replace(/^\/+|\/+$/g, '');

    return (this.folder() ? this.folder() + '/' : '') + name;
  }

  private async submitFolder(): Promise<void> {
    if (!this.name.value.trim()) return this.showError(t('folderNameRequired'));
    const res = await fetch('/api/dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: this.folderPath(),
        private: this.visibility ? this.visibility.value === 'private' : undefined,
      }),
    });

    if (!res.ok) {
      return this.showError(t(res.status === 409 ? 'folderExists' : res.status === 400 ? 'folderNameInvalid' : 'folderCreateFailed'));
    }
    this.close();
    await refreshTreeOrReload();
    setStatus(t('folderCreated'), 'ok');
  }

  // One card per option of the template <select> (extensions add theirs to it).
  private renderCards(): void {
    this.cards.replaceChildren(
      ...Array.from(this.template.options).map((opt) => {
        const card = document.createElement('button');
        const key = 'tpl_' + opt.value;
        const label = opt.value === 'blank' ? t('tplBlank') : t(key) !== key ? t(key) : opt.textContent || opt.value;
        const active = opt.value === this.template.value;

        card.type = 'button';
        card.className = 'nf-card' + (active ? ' active' : '');
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', String(active));
        card.textContent = label.charAt(0).toUpperCase() + label.slice(1);
        card.addEventListener('click', () => {
          this.template.value = opt.value;
          this.template.dispatchEvent(new Event('change'));
          this.name.focus();
        });

        return card;
      }),
    );
  }

  // Something shared from another app: its first line as the title, the rest as the body.
  openCapture(text: string): void {
    const [first, ...rest] = text.trim().split('\n');

    this.open();
    this.setMode('capture');
    this.captureTitle.value = first.slice(0, 120);
    this.captureBody.value = first.length > 120 ? text : rest.join('\n').trim();
    setTimeout(() => this.captureTitle.focus(), 60);
  }

  private showError(msg: string): void {
    this.error.textContent = msg;
    this.error.classList.remove('hidden');
  }

  // Quick capture: drop a title (+ optional body) straight into inbox/ for later triage. The inbox
  // poll surfaces it; it stays sealed from the tree/search until you keep it.
  private async submitCapture(): Promise<void> {
    const title = this.captureTitle.value.trim();

    if (!title) return this.showError(t('titleRequired'));

    const body = this.captureBody.value.trim();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr =
      now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const slug = (slugify(title) || 'note').slice(0, 50);
    const path = 'inbox/' + dateStr + '-' + slug + '.md';
    const content = '# ' + title + '\n\n_Capture : ' + now.toLocaleString('fr-FR') + '_\n\n' + body + '\n';

    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.close();
      setStatus(t('noteSaved'), 'ok');
    } catch (err) {
      this.showError(t('errSp', (err as Error).message));
    }
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.classList.add('hidden');

    if (this.mode === 'capture') return this.submitCapture();
    if (this.mode === 'folder') return this.submitFolder();

    let title = this.name.value.trim();
    const provider = this.registry.activeProvider();
    let content!: string; // assigned in both the provider and the !provider branch below

    if (provider) {
      // The extension generator produces the content (+ a fallback slug). A thrown error is the user message.
      try {
        const built = await provider.generate();

        content = built.content;

        if (!title) title = (built.slug || '').trim();
      } catch (err) {
        return this.showError((err as Error).message);
      }
    }

    if (!title) return this.showError(t('titleRequired'));
    const path = this.pathFor(title);

    if (!provider) content = TemplateRegistry.buildContent(this.template.value, title);

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
      // Straight to writing it: the title was the second and last gesture.
      if (fileMap[path]) {
        await docRenderer.show(fileMap[path]);
        editor.enterEditMode();
      }
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
// Order: settings → new-file → dir-rename → share → rename.
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
