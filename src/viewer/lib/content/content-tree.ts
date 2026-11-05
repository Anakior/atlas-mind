// Sidebar tree + content loader. The tree renders through the Atlas DOM runtime: openDirs is
// state, render(treeView(TREE), treeEl) reuses live nodes so the scroll offset survives a reload
// (golden C), and the open/closed state is keyed on the FULL dir path so homonym folders stay
// independent (golden B). The content loader + the markdown setup are module-level exports other
// modules import; only the tree's internals are encapsulated in the class.

import { IS_OFFLINE_BUILD, EMBED_CONTENT, TREE, docPath, docUrl } from '../core/data-csrf';
import { t } from '../core/i18n';
import { requestError } from '../core/net';
import { docHash } from '../core/route';
import { fileMap, docLabel } from '../core/tree';
import { treeEl } from '../core/dom-refs';
import { currentFile } from '../core/state';
import { h, raw, render } from '../runtime/atlas-dom';
import { renameModal } from '../modals/dialogs';
import { dirRenameModal, newFileModal, deleteEmptyFolder } from '../modals/new-file-modal';
import { settingsPage } from '../admin/settings/settings-page';
import { docRenderer, isViewable, IMAGE_EXTS } from './doc-renderer';
import { decorateTreeBadges } from './notes/notes-index';
import { startMove, startMoveFolder } from './file-drop';

// ─── Content loader (a small service; kept as functions for now, classed later) ───────────────
// A doc's text, for the mtime the tree gave it: a doc the AI (or another device) changed comes back
// from the tree with a new mtime, so reopening it fetches the new text instead of showing the old one.
const contentCache = new Map<string, { mtime: number; text: string }>();

export function rememberContent(file: FileNode, text: string): void {
  contentCache.set(file.path, { mtime: file.mtime, text });
  file.content = text;
}

// A write made elsewhere (a revert, a move, an extension): the next open fetches the doc again.
export function forgetContent(path: string): void {
  contentCache.delete(path);
  for (const f of [fileMap[path], currentFile]) if (f && f.path === path) f.content = undefined;
}

export async function loadContent(file: FileNode): Promise<string> {
  if (file.content != null) return file.content; // offline-baked or already loaded

  const cached = contentCache.get(file.path);

  if (cached && cached.mtime === file.mtime) {
    file.content = cached.text;

    return cached.text;
  }
  if (IS_OFFLINE_BUILD) {
    const c = EMBED_CONTENT![file.path];

    if (c == null) throw new Error(t('offlineMissing'));
    rememberContent(file, c);

    return c;
  }

  const res = await fetch(docPath(file.path) + (file.mtime ? '?v=' + file.mtime : ''));

  if (!res.ok) throw requestError(res.status);

  const text = await res.text();

  rememberContent(file, text);

  return text;
}

// Every write of a whole doc says which text it started from (base_content): the server then answers
// 409 with its current text instead of overwriting a doc that changed meanwhile.
export async function putDoc(body: FilePutBody): Promise<{ ok: true; mtime: number } | { ok: false; current: string }> {
  const res = await fetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 409) return { ok: false, current: ((await res.json()) as { current?: string }).current ?? '' };
  if (!res.ok) throw requestError(res.status);

  return { ok: true, mtime: ((await res.json()) as { mtime?: number }).mtime || Math.floor(Date.now() / 1000) };
}

// Shared with the todo widget + showWelcome; exported here as the common owner those modules import.
export let todos: any[] = [];

export function setTodos(v: any[]): void {
  todos = v;
}

export let notesIndex: Record<string, number> | null = null;

export function setNotesIndex(v: Record<string, number> | null): void {
  notesIndex = v;
}

// ─── Markdown pipeline base (marked options, wikilink maps) — the Markdown class in markdown.ts
// builds on this base config. ──────────────────────────────────────────────────────────────────
marked.setOptions({ gfm: true, breaks: false });

// Wikilinks [[doc]]: target → path resolution (direct path, else stem). Maps built once over
// fileMap; any openable doc is a valid target. Nulled on reload (was a latent stale-cache bug).
export const WL_TARGET_EXTS = ['.md', '.html', '.pdf', '.docx'];
export let _wlMaps: { byPath: Record<string, string>; byStem: Record<string, string> } | null = null;

export function setWlMaps(
  v: { byPath: Record<string, string>; byStem: Record<string, string> } | null,
): void {
  _wlMaps = v;
}

export function wlMaps(): { byPath: Record<string, string>; byStem: Record<string, string> } {
  if (_wlMaps) return _wlMaps;

  const byPath: Record<string, string> = {};
  const byStem: Record<string, string> = {};

  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    byPath[f.path.toLowerCase()] = f.path;
    const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();

    if (!(stem in byStem)) byStem[stem] = f.path;
  }
  _wlMaps = { byPath, byStem };

  return _wlMaps;
}

// ─── The tree ─────────────────────────────────────────────────────────────────────────────────
export class ContentTree {
  // Open folders, keyed on the FULL dir path (homonym independence). A top-level dir opens the
  // first time it appears; after that, reloads (SSE rebuilds included) keep the user's folds.
  private openDirs = new Set<string>();
  private seenTopDirs = new Set<string>();
  // The doc whose folders were last opened for it. They open once, when it is shown, and stay
  // the user's to fold: opening them on every render kept a folder holding the active doc stuck open.
  private revealed: string | null = null;

  private static readonly ICONS: Record<string, string> = {
    '.md': '<svg class="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    '.pdf': '<svg class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
    '.pptx': '<svg class="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>',
    '.html': '<svg class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
    '.docx': '<svg class="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    '.json': '<svg class="w-4 h-4 text-amber-300 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 4H7a2 2 0 00-2 2v3a2 2 0 01-2 2 2 2 0 012 2v3a2 2 0 002 2h1m8-16h1a2 2 0 012 2v3a2 2 0 002 2 2 2 0 00-2 2v3a2 2 0 01-2 2h-1"/></svg>',
  };
  private static readonly IMAGE_ICON = '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
  private static readonly FOLDER_ICON = '<svg class="w-4 h-4 text-[#fbc678] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
  private static readonly REMOTE_FOLDER_ICON = '<svg class="w-4 h-4 text-[#59d0cf] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>';
  private static readonly LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>';
  private static readonly PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-3.5 h-3.5"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>';
  private static readonly TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>';
  private static readonly PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>';
  private static readonly FILE_ICON = '<svg class="w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';
  private static readonly ACL_ICON = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>';

  private iconFor(ext: string): string {
    return ContentTree.ICONS[ext] || (IMAGE_EXTS.includes(ext) ? ContentTree.IMAGE_ICON : ContentTree.FILE_ICON);
  }

  // Reload (boot / SSE rebuild): open the top-level dirs new to this page, then render.
  reload(): void {
    const children = TREE.type === 'dir' ? TREE.children : [];

    for (const c of children) {
      if (c.type === 'dir' && !this.seenTopDirs.has(c.name)) {
        this.seenTopDirs.add(c.name);
        this.openDirs.add(c.name);
      }
    }
    this.rerender();
  }

  rerender(): void {
    if (currentFile && currentFile.path !== this.revealed) {
      this.revealed = currentFile.path;
      const parts = currentFile.path.split('/');

      for (let i = 1; i < parts.length; i++) this.openDirs.add(parts.slice(0, i).join('/'));
    }
    // serverBoot fills treeEl with skeleton rows via innerHTML — foreign nodes the keyed runtime does
    // not own, so they'd linger below the real tree. Drop them once before the first real render; once
    // gone, later reloads reconcile in place (scroll + open folders survive).
    if (treeEl.querySelector('.skeleton')) treeEl.replaceChildren();
    render(this.treeView(TREE, 0, ''), treeEl);
  }

  private treeView(node: TreeNode, depth: number, prefix: string): VNode {
    const cls = depth === 0 ? 'space-y-0.5' : 'ml-3 border-l border-navy-600 pl-2 space-y-0.5 mt-0.5';
    let children = node.type === 'dir' ? node.children : [];

    if (depth === 0) {
      // The remotes/ umbrella (mirrors of OTHER atlases) is pushed to the very bottom.
      const own: TreeNode[] = [];
      const remotes: TreeNode[] = [];

      for (const c of children) (c.type === 'dir' && c.name === 'remotes' ? remotes : own).push(c);
      children = own.concat(remotes);
    }

    if (!children.length && depth > 0 && !IS_OFFLINE_BUILD && !prefix.startsWith('remotes')) {
      return h('ul', { class: cls }, [
        h('li', { key: 'add:' + prefix },
          h('button', { type: 'button', class: 'tree-add w-full text-left px-2 py-1 rounded text-xs', onClick: () => newFileModal.open(prefix) }, t('addInEmptyFolder'))),
      ]);
    }

    return h('ul', { class: cls }, children.map((c) => (c.type === 'dir' ? this.dirView(c, depth, prefix) : this.fileView(c))));
  }

  private dirView(child: DirNode, depth: number, prefix: string): VNode {
    const childPath = prefix ? prefix + '/' + child.name : child.name;
    const isRemoteRoot = childPath === 'remotes';
    const isRemote = isRemoteRoot || childPath.startsWith('remotes/');
    const open = this.openDirs.has(childPath);
    const dirLabel = isRemoteRoot ? t('remotesLabel') : child.name;

    const actions: VNode[] = [];

    if (!isRemote) {
      actions.push(
        this.action('dir-new-btn', 'newInFolder', ContentTree.PLUS_ICON, () => newFileModal.open(childPath)),
        this.action('dir-access-btn', 'aclBtnTitle', ContentTree.ACL_ICON, () => window.openAccessFor?.(childPath)),
        this.action('dir-rename-btn', 'renameFolder', ContentTree.PENCIL_ICON, () => dirRenameModal.open(childPath)),
        this.action('dir-share-btn tree-action-btn--share', 'shareAsNode', ContentTree.LINK_ICON, () => settingsPage.openPublish(childPath)),
      );
    }
    if (child.keep && !child.children.length) {
      actions.push(this.action('dir-delete-btn', 'deleteFolder', ContentTree.TRASH_ICON, () => void deleteEmptyFolder(childPath)));
    }

    const btn = h('button', {
      type: 'button',
      class: 'tree-item w-full text-left px-2 py-1.5 rounded flex items-center gap-2 font-semibold text-ink-100' + (isRemote ? ' tree-remote' : ''),
      'data-dir-path': childPath,
      'aria-expanded': open ? 'true' : 'false',
      draggable: isRemote || IS_OFFLINE_BUILD ? null : 'true',
      onDragstart: (e: DragEvent) => startMoveFolder(e, childPath),
      onClick: () => this.toggleDir(childPath),
    },
    h('span', { class: 'caret text-xs text-ink-400' + (open ? ' open' : ''), 'aria-hidden': 'true' }, raw('&#9656;')),
    raw(isRemoteRoot ? ContentTree.REMOTE_FOLDER_ICON : ContentTree.FOLDER_ICON),
    h('span', { class: 'truncate min-w-0 flex-1', 'data-name': child.name }, dirLabel));

    const sub = this.treeView(child, depth + 1, childPath);

    if (!open) sub.props.class += ' hidden';

    return h('li', { key: 'd:' + childPath, class: isRemoteRoot ? 'tree-section--remotes' : null }, h('div', { class: 'tree-row group' }, btn, actions), sub);
  }

  private fileView(child: FileNode): VNode {
    const isRemoteFile = child.path.startsWith('remotes/');
    const openable = isViewable(child.ext);
    const fileActionable = !isRemoteFile && (child.ext === '.md' || child.ext === '.html');
    const actions = fileActionable
      ? [
        this.action('file-access-btn', 'aclBtnTitle', ContentTree.ACL_ICON, () => window.openAccessFor?.(child.path)),
        this.action('file-rename-btn', 'renameFile', ContentTree.PENCIL_ICON, () => { void docRenderer.open(child); renameModal.open('rename'); }),
        this.action('file-share-btn tree-action-btn--share', 'shareAsNode', ContentTree.LINK_ICON, () => settingsPage.openPublish(child.path)),
      ]
      : [];

    const props: Record<string, any> = {
      class: 'tree-item w-full px-2 py-1.5 rounded flex items-start gap-2 cursor-pointer text-ink-200' + (isRemoteFile ? ' tree-remote' : ''),
      'data-path': child.path,
      // Dragged onto a folder, it moves there (file-drop.ts).
      draggable: isRemoteFile || IS_OFFLINE_BUILD ? null : 'true',
      onDragstart: (e: DragEvent) => startMove(e, child.path),
      // An openable doc opens in place; the link is there for a new tab and the keyboard.
      href: openable ? docHash(child.path) : docUrl(child.path),
    };

    if (currentFile && child.path === currentFile.path) props.class += ' active';
    if (openable) {
      props.onClick = (e: MouseEvent) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        void docRenderer.open(child);
      };
    }

    return h('li', { key: 'l:' + child.path }, h('div', { class: 'tree-row group' },
      h('a', props,
        h('span', { class: 'tree-ico' }, raw(this.iconFor(child.ext)), this.visBadge(child)),
        h('span', { class: 'truncate min-w-0 flex-1 leading-snug', 'data-name': child.name, title: child.title ? child.name : null }, docLabel(child))),
      actions));
  }

  // A row's own action: a real button beside the row's link, so the keyboard reaches it.
  private action(cls: string, labelKey: string, icon: string, run: () => void): VNode {
    return h('button', { type: 'button', class: 'tree-action-btn ' + cls, title: t(labelKey), onClick: run }, raw(icon));
  }

  // On the icon: the row's end holds the actions. A shape per state as well as a colour, and a name
  // for a screen reader.
  private visBadge(child: FileNode): Child {
    if (!child.vis) return null;

    const label = t(child.vis === 'private' ? 'visPrivate' : child.vis === 'shared' ? 'visShared' : 'visGranted');

    return h('span', { class: 'tree-vis tree-vis--' + child.vis, role: 'img', 'aria-label': label, title: label });
  }

  private toggleDir(path: string): void {
    if (this.openDirs.has(path)) this.openDirs.delete(path);
    else this.openDirs.add(path);
    this.rerender();
  }

  // Toolbar #tree-toggle-all: collapse everything if anything is open, else expand all.
  toggleAll(): void {
    if (this.openDirs.size === 0) {
      const all: string[] = [];
      const walk = (node: TreeNode, prefix: string) => {
        const children = node.type === 'dir' ? node.children : [];

        for (const c of children) {
          if (c.type !== 'dir') continue;
          const p = prefix ? prefix + '/' + c.name : c.name;

          all.push(p);
          walk(c, p);
        }
      };

      walk(TREE, '');
      this.openDirs = new Set(all);
    } else {
      this.openDirs.clear();
    }
    this.rerender();
  }

  // Under each mirror (remotes/<name>), show which atlas it comes from. Admin-only → silent.
  async decorateRemoteOrigins(): Promise<void> {
    let remotes;

    try {
      const resp = await fetch('/api/admin/remotes', { headers: { Accept: 'application/json' } });

      if (!resp.ok) return;
      remotes = await resp.json();
    } catch (_) {
      return;
    }
    if (!Array.isArray(remotes)) return;

    for (const r of remotes) {
      const host = (r.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      if (!host) continue;
      const sel = 'button[data-dir-path="remotes/' + (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name) + '"]';
      const btn = treeEl.querySelector(sel);

      if (!btn || btn.querySelector('.tree-remote-origin')) continue;

      const span = document.createElement('span');

      span.className = 'tree-remote-origin';
      span.textContent = host;
      span.title = r.url || '';
      btn.appendChild(span);
    }
  }
}

export const contentTree = new ContentTree();

// Toolbar: expand/collapse every folder.
(function () {
  const btn = document.getElementById('tree-toggle-all');

  if (!btn) return;
  btn.dataset.tip = t('expandAllFolders');
  btn.setAttribute('aria-label', t('expandAllFolders'));
  btn.addEventListener('click', () => contentTree.toggleAll());
})();

// In SERVER mode the baked tree is the owner's FULL build-time view — never rendered (privacy);
// the bootstrap fetches the per-account /api/tree via softReload. Only the offline build renders
// the embedded tree directly. Gated on IS_OFFLINE_BUILD, not the protocol (GitHub Pages is https).
if (IS_OFFLINE_BUILD) {
  contentTree.reload();
  decorateTreeBadges();
  contentTree.decorateRemoteOrigins();
}
