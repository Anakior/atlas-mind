// The folder-rename dialog. POSTs /api/dir/rename, then reconciles the tree (and any open doc's hash)
// via refreshTreeOrReload. Extends the shared Modal lifecycle (01c-modal-base.ts); instantiated by
// 19-newfile.ts, which also owns the dirRenameBackdrop ref and the openDirRenameModal global. Concatenated
// before 19-newfile.ts so the class exists when `new DirRenameModal()` runs at module init.
class DirRenameModal extends Modal {
  private readonly form = document.getElementById('dir-rename-form') as HTMLFormElement;
  private readonly input = document.getElementById('dir-rename-input') as HTMLInputElement;
  private readonly current = document.getElementById('dir-rename-current') as HTMLElement;
  private readonly error = document.getElementById('dir-rename-error') as HTMLElement;
  private readonly cancel = document.getElementById('dir-rename-cancel') as HTMLElement;
  private sourcePath: string | null = null;

  constructor() {
    super(dirRenameBackdrop!);
    this.cancel.addEventListener('click', () => this.close());
    document.getElementById('dir-rename-close')?.addEventListener('click', () => this.close());
    this.form.addEventListener('submit', (e) => this.submit(e));
  }

  open(path: string): void {
    if (window.__viewerMode || !path) return;
    this.sourcePath = path;
    const parts = path.split('/');

    this.current.textContent = path;
    this.input.value = parts[parts.length - 1];
    this.error.classList.add('hidden');
    this.reveal();
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 50);
  }

  close(): void {
    super.close();
    this.sourcePath = null;
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.classList.add('hidden');

    if (!this.sourcePath) return;
    const newName = this.input.value.trim().replace(/^\/+|\/+$/g, '');

    if (!newName) {
      this.error.textContent = t('nameRequired');
      this.error.classList.remove('hidden');

      return;
    }

    if (/[\\\/]/.test(newName)) {
      this.error.textContent = t('noSlashes');
      this.error.classList.remove('hidden');

      return;
    }

    const parts = this.sourcePath.split('/');

    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    if (newPath === this.sourcePath) {
      this.close();

      return;
    }

    try {
      const res = await fetch('/api/dir/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.sourcePath, to: newPath }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));

        throw new Error(err.error || 'HTTP ' + res.status);
      }

      this.close();
      // The tree (and any open doc's hash) is reconciled by refreshTreeOrReload below.
      setStatus(t('folderRenamed'), 'ok');
      await refreshTreeOrReload();
    } catch (err) {
      this.error.textContent = t('errSp', (err as Error).message);
      this.error.classList.remove('hidden');
    }
  }
}
