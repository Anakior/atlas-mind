// Files into the mind from outside it. Dropped on the tree, they land in the folder under the
// pointer (a tree folder, the folder of a tree file, or the top level); anywhere else, nowhere. Dropped or pasted
// into a note being written, they are stored beside it (as private as it, server side) and linked
// at the caret. A .zip unpacks into a folder of its name. One request per file, its bytes as the
// body; the server never replaces a file, a taken name comes back as "name (2).ext".
// A note, a file or a folder of the tree, dragged onto a folder, moves there (its links follow,
// server side).

import { t } from '../core/i18n';
import { setStatus } from '../core/net';
import { currentFile, editMode, editTextarea, isServerMode } from '../core/state';
import { fileMap } from '../core/tree';
import { treeEl } from '../core/dom-refs';
import { mdInsertAtCursor } from './tags';
import { IMAGE_EXTS } from './doc-renderer';
import { refreshTreeOrReload } from '../modals/new-file-modal';

type Target = { folder: string; mark: HTMLElement | null } | 'note';

// What a tree row carries when dragged: its path, under a type of our own (one for a folder).
const MOVE_TYPE = 'application/x-atlas-path';
const FOLDER_TYPE = 'application/x-atlas-folder';

// A tree file starts moving (content-tree.ts). Mirrors of another atlas are read-only.
export function startMove(e: DragEvent, path: string): void {
  if (!e.dataTransfer || path.startsWith('remotes/')) return;
  e.dataTransfer.setData(MOVE_TYPE, path);
  e.dataTransfer.effectAllowed = 'move';
}

export function startMoveFolder(e: DragEvent, path: string): void {
  if (!e.dataTransfer || path.startsWith('remotes')) return;
  e.dataTransfer.setData(FOLDER_TYPE, path);
  e.dataTransfer.effectAllowed = 'move';
}

async function moveFolderTo(path: string, folder: string): Promise<void> {
  const to = folder + path.slice(path.lastIndexOf('/') + 1);

  if (to === path || folder.startsWith(path + '/')) return;
  const res = await fetch('/api/dir/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: path, to }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: '' }));

    setStatus(t('moveFailed', error || 'HTTP ' + res.status), 'err');

    return;
  }
  if (currentFile && currentFile.path.startsWith(path + '/')) {
    currentFile.path = to + currentFile.path.slice(path.length);
    location.hash = '#' + encodeURIComponent(currentFile.path);
  }
  await refreshTreeOrReload();
  setStatus(t('folderMoved'), 'ok');
}

async function moveTo(path: string, folder: string): Promise<void> {
  const to = folder + path.slice(path.lastIndexOf('/') + 1);

  if (to === path) return;
  const res = await fetch('/api/file/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: path, to }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: '' }));

    setStatus(t('moveFailed', error || 'HTTP ' + res.status), 'err');

    return;
  }
  if (currentFile && currentFile.path === path) {
    currentFile.path = to;
    location.hash = '#' + encodeURIComponent(to);
  }
  await refreshTreeOrReload();
  setStatus(t('docMoved'), 'ok');
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
const extOf = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');

async function send(file: File, path: string, beside?: string): Promise<{ paths: string[]; skipped: string[] }> {
  const query = 'path=' + encodeURIComponent(path) + (beside ? '&beside=' + encodeURIComponent(beside) : '');
  const res = await fetch('/api/upload?' + query, {
    method: 'POST',
    // Explicit: a browser types a .txt as text/plain, which the server refuses from a form.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const code = res.status === 413 ? 'too_large' : res.status === 403 ? 'forbidden' : data.error;

    throw new Error(t('upErr_' + (['too_large', 'forbidden', 'bad_type', 'bad_zip'].includes(code) ? code : 'other'), file.name));
  }

  return { paths: data.paths || [], skipped: data.skipped || [] };
}

// Files into `folder` ('' = the root, else ending in '/'). Opens the file when it was the only one.
export async function sendToFolder(files: File[], folder: string): Promise<void> {
  const added: string[] = [];
  const problems: string[] = [];
  let skipped = 0;

  setStatus(t('upSending', files.length), 'info');
  for (const file of files) {
    try {
      const sent = await send(file, folder + file.name);

      added.push(...sent.paths);
      skipped += sent.skipped.length;
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (added.length === 1 && files.length === 1 && extOf(files[0].name) !== '.zip') {
    location.hash = '#' + encodeURIComponent(added[0]);
  }
  if (added.length) await refreshTreeOrReload();
  const parts = [added.length ? t('upAdded', added.length) : '', skipped ? t('upSkipped', skipped) : '', ...problems];

  setStatus(parts.filter(Boolean).join(' · '), problems.length || skipped ? 'err' : 'ok');
}

// Files into the note being written: stored beside it, linked where the caret is.
async function sendToNote(files: File[], pasted: boolean): Promise<void> {
  const note = currentFile;

  if (!note) return;
  const folder = folderOf(note.path);
  const stem = note.name.replace(/\.[^.]+$/, '');

  for (const file of files) {
    const ext = extOf(file.name) || '.' + (file.type.split('/')[1] || 'png');
    // A pasted screenshot is always "image.png": name it after the note instead.
    const name = pasted ? stem + '-image' + ext : file.name;

    try {
      const [path] = (await send(file, folder + name, note.path)).paths;
      const rel = path.slice(folder.length);
      const dest = /[\s()<>]/.test(rel) ? '<' + rel + '>' : rel;

      mdInsertAtCursor(IMAGE_EXTS.includes(extOf(rel)) ? '![](' + dest + ')' : '[' + rel + '](' + dest + ')');
    } catch (e) {
      setStatus((e as Error).message, 'err');
    }
  }
  await refreshTreeOrReload();
}

class FileDrop {
  private hint = document.createElement('div');
  private marked: HTMLElement | null = null;

  constructor() {
    this.hint.className = 'file-drop-hint hidden';
    document.body.appendChild(this.hint);
    window.addEventListener('dragover', (e) => this.over(e));
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this.clear();
    });
    window.addEventListener('drop', (e) => this.drop(e));
    document.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files || []);

      if (!editMode || e.target !== editTextarea || !files.length) return;
      e.preventDefault();
      sendToNote(files, true);
    });
  }

  // Files from outside, or a tree row being moved; null for any other drag.
  private static carried(e: DragEvent): 'files' | 'move' | null {
    const types = Array.from(e.dataTransfer?.types || []);

    if (window.__viewerMode) return null;

    if (types.includes('Files')) return 'files';

    return types.includes(MOVE_TYPE) || types.includes(FOLDER_TYPE) ? 'move' : null;
  }

  private target(e: DragEvent, moving = false): Target | null {
    const el = e.target as Element;

    if (!moving && editMode && el === editTextarea) return 'note';
    if (!treeEl.contains(el)) return null;
    const dir = el.closest('[data-dir-path]') as HTMLElement | null;

    if (dir) return dir.dataset.dirPath!.startsWith('remotes') ? null : { folder: dir.dataset.dirPath + '/', mark: dir };
    const file = el.closest('[data-path]') as HTMLElement | null;

    return { folder: file ? folderOf(file.dataset.path!) : '', mark: null };
  }

  private over(e: DragEvent): void {
    const kind = FileDrop.carried(e);
    const target = kind && this.target(e, kind === 'move');

    if (!target) {
      // Else the browser opens the file in place of Atlas.
      if (kind === 'files') {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'none';
      }

      return this.clear();
    }
    e.preventDefault();
    e.dataTransfer!.dropEffect = kind === 'move' ? 'move' : 'copy';
    const mark = target === 'note' ? null : target.mark;

    if (mark !== this.marked) {
      this.marked?.classList.remove('drop-into');
      mark?.classList.add('drop-into');
      this.marked = mark;
    }
    const where = target === 'note' ? '' : target.folder.replace(/\/$/, '') || t('dropRoot');

    this.hint.textContent = target === 'note' ? t('dropIntoNote') : t(kind === 'move' ? 'dropMoveInto' : 'dropInto', where);
    this.place(e.target as Element);
    this.hint.classList.remove('hidden');
  }

  private place(el: Element): void {
    const anchored = treeEl.contains(el);

    this.hint.classList.toggle('is-anchored', anchored);
    if (!anchored) {
      this.hint.style.left = this.hint.style.top = '';

      return;
    }
    const box = treeEl.getBoundingClientRect();

    this.hint.style.left = box.left + 'px';
    this.hint.style.top = box.top + 'px';
  }

  private clear(): void {
    this.hint.classList.add('hidden');
    this.marked?.classList.remove('drop-into');
    this.marked = null;
  }

  private drop(e: DragEvent): void {
    const kind = FileDrop.carried(e);
    const target = kind && this.target(e, kind === 'move');

    if (!target) {
      if (kind === 'files') e.preventDefault();

      return;
    }
    e.preventDefault();
    this.clear();
    if (kind === 'move') {
      if (target === 'note') return;
      const dir = e.dataTransfer!.getData(FOLDER_TYPE);
      const path = e.dataTransfer!.getData(MOVE_TYPE);

      if (dir) void moveFolderTo(dir, target.folder);
      else if (path && fileMap[path]) void moveTo(path, target.folder);

      return;
    }
    const files = Array.from(e.dataTransfer!.files);

    if (!files.length) return;
    if (target === 'note') sendToNote(files, false);
    else sendToFolder(files, target.folder);
  }
}

if (isServerMode) new FileDrop();
