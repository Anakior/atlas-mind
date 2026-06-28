// Sidebar tree + content loader. The tree renders through the Atlas DOM runtime: openDirs is
// state, render(treeView(TREE), treeEl) reuses live nodes so the scroll offset survives a reload
// (golden C), and the open/closed state is keyed on the FULL dir path so homonym folders stay
// independent (golden B). The content loader + the markdown setup are module-level exports other
// modules import; only the tree's internals are encapsulated in the class.

import { IS_OFFLINE_BUILD, EMBED_CONTENT, TREE } from '../core/data-csrf';
import { t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { fileMap } from '../core/tree';
import { treeEl } from '../core/dom-refs';
import { currentFile } from '../core/state';
import { h, raw, render } from '../runtime/atlas-dom';
import { renameModal } from '../modals/dialogs';
import { dirRenameModal } from '../modals/new-file-modal';
import { settingsPanel } from '../admin/settings/settings-panel';
import { docRenderer } from './doc-renderer';
import { decorateTreeBadges } from './notes/notes-index';

// ─── Content loader (a small service; kept as functions for now, classed later) ───────────────
export const contentCache = new Map<string, string>();

export async function loadContent(file: FileNode): Promise<string> {
  if (file.content != null) return file.content; // offline-baked or already loaded

  const cached = contentCache.get(file.path);

  if (cached != null) {
    file.content = cached;

    return cached;
  }
  if (IS_OFFLINE_BUILD) {
    const c = EMBED_CONTENT![file.path];

    if (c == null) throw new Error(t('offlineMissing'));
    contentCache.set(file.path, c);
    file.content = c;

    return c;
  }

  const url = '/' + file.path.split('/').map(encodeURIComponent).join('/') + (file.mtime ? '?v=' + file.mtime : '');
  const res = await fetch(url);

  if (!res.ok) throw new Error('HTTP ' + res.status);

  const text = await res.text();

  contentCache.set(file.path, text);
  file.content = text;

  return text;
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

// ─── Markdown pipeline base (marked + hljs config, wikilink maps) — the Markdown class in
// markdown.ts builds on this base config. ──────────────────────────────────────────────────────
marked.setOptions({ gfm: true, breaks: false });
// marked ≥ v5 dropped the `highlight` option (silently ignored by the vendored v15), so highlight
// in a custom `code` renderer instead. The hljs output survives DOMPurify; the `hljs` class enables
// the vendored github-dark theme.
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let html;

      try {
        html =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language }).value
            : hljs.highlightAuto(text).value;
      } catch (e) {
        html = escapeHtml(text);
      }

      const cls = language ? ' language-' + escapeHtml(language) : '';

      return '<pre><code class="hljs' + cls + '">' + html + '</code></pre>\n';
    },
  },
});

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
  // Open folders, keyed on the FULL dir path (homonym independence). Top-level dirs are seeded
  // open on every reload (force-open after an SSE rebuild); a plain rerender keeps a user's closes.
  private openDirs = new Set<string>();

  private static readonly ICONS: Record<string, string> = {
    '.md': '<svg class="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
    '.pdf': '<svg class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
    '.pptx': '<svg class="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>',
    '.html': '<svg class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
    '.docx': '<svg class="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  };
  private static readonly FOLDER_ICON = '<svg class="w-4 h-4 text-[#fbc678] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
  private static readonly REMOTE_FOLDER_ICON = '<svg class="w-4 h-4 text-[#59d0cf] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>';
  private static readonly LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>';
  private static readonly PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>';
  private static readonly FILE_ICON = '<svg class="w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';
  private static readonly ACL_ICON = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>';

  private iconFor(ext: string): string {
    return ContentTree.ICONS[ext] || ContentTree.FILE_ICON;
  }

  // Reload (boot / SSE rebuild): force the top-level dirs open, then render — a user's nested
  // toggles in openDirs are preserved.
  reload(): void {
    const children = TREE.type === 'dir' ? TREE.children : [];

    for (const c of children) if (c.type === 'dir') this.openDirs.add(c.name);
    this.rerender();
  }

  rerender(): void {
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

    return h('ul', { class: cls }, children.map((c) => (c.type === 'dir' ? this.dirView(c, depth, prefix) : this.fileView(c))));
  }

  private dirView(child: DirNode, depth: number, prefix: string): VNode {
    const childPath = prefix ? prefix + '/' + child.name : child.name;
    const isRemoteRoot = childPath === 'remotes';
    const isRemote = isRemoteRoot || childPath.startsWith('remotes/');
    // Open if toggled open, or if it holds the active doc (so a reload never hides what's open).
    const open = this.openDirs.has(childPath) || !!(currentFile && currentFile.path.startsWith(childPath + '/'));
    const dirLabel = isRemoteRoot ? t('remotesLabel') : child.name;

    const btnChildren: Child[] = [
      h('span', { class: 'caret text-xs text-ink-400' + (open ? ' open' : '') }, raw('&#9656;')),
      raw(isRemoteRoot ? ContentTree.REMOTE_FOLDER_ICON : ContentTree.FOLDER_ICON),
      h('span', { class: 'truncate min-w-0 flex-1', 'data-name': child.name }, dirLabel),
    ];

    if (!isRemote) {
      btnChildren.push(
        h('span', { class: 'dir-access-btn tree-action-btn', title: t('aclBtnTitle'), onClick: (e: Event) => { e.stopPropagation(); if (window.openAccessFor) window.openAccessFor(childPath); } }, raw(ContentTree.ACL_ICON)),
      );
    }
    btnChildren.push(
      h('span', { class: 'dir-rename-btn tree-action-btn', title: t('renameFolder'), onClick: (e: Event) => { e.stopPropagation(); dirRenameModal.open(childPath); } }, raw(ContentTree.PENCIL_ICON)),
    );
    if (!isRemote) {
      btnChildren.push(
        h('span', { class: 'dir-share-btn tree-action-btn tree-action-btn--share', title: t('shareAsNode'), onClick: (e: Event) => { e.stopPropagation(); settingsPanel.openPublish(childPath); } }, raw(ContentTree.LINK_ICON)),
      );
    }

    const btn = h('button', {
      class: 'tree-item group w-full text-left px-2 py-1.5 rounded flex items-center gap-2 font-semibold text-ink-100' + (isRemote ? ' tree-remote' : ''),
      'data-dir-path': childPath,
      onClick: () => this.toggleDir(childPath),
    }, btnChildren);

    const sub = this.treeView(child, depth + 1, childPath);

    if (!open) sub.props.class += ' hidden';

    return h('li', { key: 'd:' + childPath, class: isRemoteRoot ? 'tree-section--remotes' : null }, btn, sub);
  }

  private fileView(child: FileNode): VNode {
    const isRemoteFile = child.path.startsWith('remotes/');
    const openable = child.ext === '.md' || child.ext === '.html' || child.ext === '.pdf' || child.ext === '.docx';
    const fileActionable = !isRemoteFile && (child.ext === '.md' || child.ext === '.html');

    const aChildren: Child[] = [
      raw(this.iconFor(child.ext)),
      h('span', { class: 'truncate min-w-0 flex-1 leading-snug', 'data-name': child.name }, child.name),
      this.visBadge(child),
    ];

    if (fileActionable) {
      aChildren.push(
        h('span', { class: 'file-access-btn tree-action-btn', title: t('aclBtnTitle'), onClick: (e: Event) => { e.preventDefault(); e.stopPropagation(); if (window.openAccessFor) window.openAccessFor(child.path); } }, raw(ContentTree.ACL_ICON)),
        h('span', { class: 'file-rename-btn tree-action-btn', title: t('renameFile'), onClick: (e: Event) => { e.preventDefault(); e.stopPropagation(); docRenderer.show(child); renameModal.open('rename'); } }, raw(ContentTree.PENCIL_ICON)),
        h('span', { class: 'file-share-btn tree-action-btn tree-action-btn--share', title: t('shareAsNode'), onClick: (e: Event) => { e.preventDefault(); e.stopPropagation(); settingsPanel.openPublish(child.path); } }, raw(ContentTree.LINK_ICON)),
      );
    }

    const props: Record<string, any> = {
      key: 'f:' + child.path,
      class: 'tree-item group w-full px-2 py-1.5 rounded flex items-start gap-2 cursor-pointer text-ink-200' + (isRemoteFile ? ' tree-remote' : ''),
      'data-path': child.path,
    };

    if (currentFile && child.path === currentFile.path) props.class += ' active';
    if (openable) {
      props.onClick = (e: Event) => {
        e.preventDefault();
        docRenderer.show(child);
        history.replaceState(null, '', '#' + encodeURIComponent(child.path));
      };
    } else {
      props.href = encodeURI(child.path);
    }

    return h('li', { key: 'l:' + child.path }, h('a', props, aChildren));
  }

  private visBadge(child: FileNode): Child {
    const color =
      child.vis === 'private' ? 'rgba(251,191,36,.85)'
        : child.vis === 'shared' ? 'rgba(56,189,248,.85)'
          : child.vis === 'granted' ? 'rgba(52,211,153,.9)'
            : null;

    if (!color) return null;

    const titleKey = child.vis === 'private' ? 'visPrivate' : child.vis === 'shared' ? 'visShared' : 'visGranted';

    return h('span', { class: 'flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full', style: 'background-color:' + color, title: t(titleKey) });
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
      btn.insertBefore(span, btn.querySelector('.dir-rename-btn'));
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
