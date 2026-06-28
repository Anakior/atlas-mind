// Modal layer: the in-app replacements for the browser's banned confirm/alert/prompt (Promise-based,
// so many modules `await confirmDialog`/`promptDialog`), plus the rename/move modal. Top-level (no IIFE):
// every public dialog stays a shared-scope global its callers reach by name; esbuild keeps those names
// with minify off.
//
// Behaviour is byte-for-behaviour with the pre-migration DOM — each dialog wires its own
// add/removeEventListener pair and the setTimeout(…, 50) focus, with no runtime/reconciler involvement.
// The rename/move modal owns its element handles + `renameMode` below; the kebab "More actions" menu that
// opens it lives in MoreActionsMenu (14a-more-menu.ts).

// ── Confirm / alert / prompt (the native-dialog replacements) ────────────────────────────────
class Dialogs {
  // Confirm + alert share this one chrome (alert reuses it as a single-OK notice).
  private static readonly backdrop = document.getElementById('confirm-backdrop')!;
  private static readonly titleEl = document.getElementById('confirm-title')!;
  private static readonly messageEl = document.getElementById('confirm-message')!;
  private static readonly okBtn = document.getElementById('confirm-ok')!;
  private static readonly cancelBtn = document.getElementById('confirm-cancel')!;

  static confirm(opts: string | DialogOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const o: DialogOptions = typeof opts === 'string' ? { message: opts } : opts || {};

      Dialogs.titleEl.textContent = o.title || t('confirm');
      Dialogs.messageEl.textContent = o.message || '';
      Dialogs.okBtn.textContent = o.confirmLabel || t('confirm');
      Dialogs.cancelBtn.textContent = o.cancelLabel || t('cancel');
      Dialogs.okBtn.className = o.destructive
        ? 'px-3 py-1.5 text-sm bg-rose-500/80 hover:bg-rose-500 text-white rounded font-medium'
        : 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium';
      Dialogs.backdrop.classList.remove('hidden');
      setTimeout(() => Dialogs.okBtn.focus(), 50);
      const cleanup = () => {
        Dialogs.backdrop.classList.add('hidden');
        Dialogs.okBtn.removeEventListener('click', onOk);
        Dialogs.cancelBtn.removeEventListener('click', onCancel);
        Dialogs.backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      };

      const onOk = () => {
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onBackdrop = (e: Event) => {
        if (e.target === Dialogs.backdrop) onCancel();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        }
      };

      Dialogs.okBtn.addEventListener('click', onOk);
      Dialogs.cancelBtn.addEventListener('click', onCancel);
      Dialogs.backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // A single-OK notice reusing the confirm chrome (so it matches every other modal). Fire-and-forget:
  // callers don't await it.
  static alert(opts: string | DialogOptions): Promise<void> {
    const o: DialogOptions = typeof opts === 'string' ? { message: opts } : opts || {};

    return new Promise((resolve) => {
      Dialogs.titleEl.textContent = o.title || t('errorTitle');
      Dialogs.messageEl.textContent = o.message || '';
      Dialogs.okBtn.textContent = o.okLabel || t('ok');
      Dialogs.okBtn.className = 'px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium';
      Dialogs.cancelBtn.classList.add('hidden'); // alert = one OK button only
      Dialogs.backdrop.classList.remove('hidden');
      setTimeout(() => Dialogs.okBtn.focus(), 50);
      const cleanup = () => {
        Dialogs.backdrop.classList.add('hidden');
        Dialogs.cancelBtn.classList.remove('hidden'); // restore for confirm
        Dialogs.okBtn.removeEventListener('click', done);
        Dialogs.backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      };

      const done = () => {
        cleanup();
        resolve();
      };

      const onBackdrop = (e: Event) => {
        if (e.target === Dialogs.backdrop) done();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          done();
        }
      };

      Dialogs.okBtn.addEventListener('click', done);
      Dialogs.backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // In an OFFLINE build every server-backed action is disabled, so show one clear "disabled offline"
  // notice (in the UI language) rather than leaking a raw network error; online, show `key`'s message.
  static notifyError(key: string, ...args: unknown[]): Promise<void> {
    if (IS_OFFLINE_BUILD) {
      return Dialogs.alert({ title: t('offlineTitle'), message: t('offlineDisabled') });
    }

    return Dialogs.alert({ title: t('errorTitle'), message: t(key, ...args) });
  }

  // Input modal. Resolves the entered value (trimmed) or null if cancelled/empty.
  static prompt(opts?: DialogOptions): Promise<string | null> {
    const o = opts || {};
    const backdrop = document.getElementById('prompt-backdrop')!;
    const input = document.getElementById('prompt-input') as HTMLInputElement;

    document.getElementById('prompt-title')!.textContent = o.title || '';
    document.getElementById('prompt-message')!.textContent = o.message || '';
    input.placeholder = o.placeholder || '';
    input.value = o.value || '';
    const okBtn = document.getElementById('prompt-ok')!;
    const cancelBtn = document.getElementById('prompt-cancel')!;

    okBtn.textContent = o.confirmLabel || t('confirm');

    return new Promise((resolve) => {
      backdrop.classList.remove('hidden');
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
      const cleanup = () => {
        backdrop.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
      };

      const onOk = () => {
        const v = input.value.trim();

        cleanup();
        resolve(v || null);
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      const onBackdrop = (e: Event) => {
        if (e.target === backdrop) onCancel();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        }
      };

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }
}

// Public globals — kept as top-level names (not class refs) because still-.js callers reach them by name.
function confirmDialog(opts: string | DialogOptions): Promise<boolean> {
  return Dialogs.confirm(opts);
}

function alertDialog(opts: string | DialogOptions): Promise<void> {
  return Dialogs.alert(opts);
}

function promptDialog(opts?: DialogOptions): Promise<string | null> {
  return Dialogs.prompt(opts);
}

function notifyError(key: string, ...args: unknown[]): Promise<void> {
  return Dialogs.notifyError(key, ...args);
}

// ── Rename / move modal ──────────────────────────────────────────────────────────────────────
// Element handles + the cross-file `renameMode`. RenameModal drives the rename/move form; the kebab
// "More actions" menu (btn-more / btn-more-menu) that opens it lives in MoreActionsMenu (14a-more-menu.ts,
// concatenated next). renameBackdrop is also probed by 19-newfile.ts's Escape stack and 99-bootstrap.
const btnMore = document.getElementById('btn-more');
const btnMoreMenu = document.getElementById('btn-more-menu');
const renameBackdrop = document.getElementById('rename-backdrop');
const renameForm = document.getElementById('rename-form');
const renameTitle = document.getElementById('rename-title');
const renameDir = document.getElementById('rename-dir');
const renameDirWrap = document.getElementById('rename-dir-wrap');
const renameName = document.getElementById('rename-name');
const renameError = document.getElementById('rename-error');
const renameCancel = document.getElementById('rename-cancel');

let renameMode: string | null = null;

// Dir combobox (move mode): created once for its side effect — the controller is never read back.
AtlasCombobox(renameDir!, { source: getAllDirs, creatable: true });

class RenameModal {
  constructor() {
    renameCancel!.addEventListener('click', () => this.close());
    document.getElementById('rename-close')?.addEventListener('click', () => this.close());
    renameBackdrop!.addEventListener('click', (e) => {
      if (e.target === renameBackdrop) this.close();
    });
    renameForm!.addEventListener('submit', (e) => this.onSubmit(e));
  }

  open(mode: 'rename' | 'move'): void {
    if (!currentFile || window.__viewerMode) return;
    renameMode = mode;
    renameError!.classList.add('hidden');
    const parts = currentFile.path.split('/');
    const currentName = parts.pop()!.replace(/\.(md|html)$/i, '');
    const currentDir = parts.join('/');

    (renameName as HTMLInputElement).value = currentName;
    (renameDir as HTMLInputElement).value = currentDir;

    if (mode === 'rename') {
      renameTitle!.textContent = t('renameDocTitle');
      renameDirWrap!.classList.add('hidden');
    } else {
      renameTitle!.textContent = t('moveDocTitle');
      renameDirWrap!.classList.remove('hidden');
    }

    renameBackdrop!.classList.remove('hidden');
    setTimeout(() => (mode === 'rename' ? renameName! : renameDir!).focus(), 50);
  }

  close(): void {
    renameBackdrop!.classList.add('hidden');
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    renameError!.classList.add('hidden');
    let name = (renameName as HTMLInputElement).value.trim();

    if (!name) {
      renameError!.textContent = t('nameRequired');
      renameError!.classList.remove('hidden');

      return;
    }

    if (/[\\\/]/.test(name)) {
      renameError!.textContent = t('noSlashes');
      renameError!.classList.remove('hidden');

      return;
    }

    // Preserve the original extension if the user didn't type it.
    if (!/\.(md|html)$/i.test(name)) {
      const ext = (/\.(md|html)$/i.exec(currentFile!.path)?.[1] || 'md').toLowerCase();

      name += '.' + ext;
    }

    const dir = (
      renameMode === 'move'
        ? (renameDir as HTMLInputElement).value.trim()
        : currentFile!.path.split('/').slice(0, -1).join('/')
    ).replace(/^\/+|\/+$/g, '');
    const newPath = dir ? dir + '/' + name : name;

    if (newPath === currentFile!.path) {
      this.close();

      return;
    }

    if (fileMap[newPath]) {
      renameError!.textContent = t('fileExistsAt');
      renameError!.classList.remove('hidden');

      return;
    }

    try {
      const res = await fetch('/api/file/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: currentFile!.path, to: newPath }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));

        throw new Error(err.error || 'HTTP ' + res.status);
      }

      this.close();
      // Move the content cache to the new path to avoid a needless re-fetch.
      const cached = contentCache.get(currentFile!.path);

      if (cached !== undefined) {
        contentCache.delete(currentFile!.path);
        contentCache.set(newPath, cached);
      }

      currentFile!.path = newPath;
      location.hash = '#' + encodeURIComponent(newPath);
      setStatus(renameMode === 'move' ? t('docMoved') : t('docRenamed'), 'ok');
      await refreshTreeOrReload();
    } catch (err) {
      renameError!.textContent = t('err', (err as Error).message);
      renameError!.classList.remove('hidden');
    }
  }
}

const renameModal = new RenameModal();

function openRenameModal(mode: 'rename' | 'move'): void {
  renameModal.open(mode);
}

// Called by 19-newfile.js's global Escape-stack handler (still .js) — keep it a top-level global.
function closeRenameModal(): void {
  renameModal.close();
}
