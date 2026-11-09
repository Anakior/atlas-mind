// The document renderer. DocRenderer.show owns #content: it writes the skeleton, gates the breadcrumb
// chrome, dispatches by extension (.html/.pdf/.docx/images/.json → frames.ts, else the markdown pipeline)
// and fires the post-render hooks. The DOM is written exactly as before (innerHTML/createElement/
// appendChild) — no reconciliation refactor — so the goldens stay byte-stable; the one structural
// change is that the tree's active/ancestor-open highlight is derived by content-tree.ts via
// contentTree.rerender() instead of an imperative DOM poke. DocRenderer.open (show + a history entry)
// and DocRenderer.show are the entry points its cross-module callers import. The anti-race guards
// compare the navigation number (currentView): a slow load for doc A must not clobber doc B.

import { IS_OFFLINE_BUILD } from '../core/data-csrf';
import { LANG, t } from '../core/i18n';
import { escapeHtml, relativeDate } from '../core/utils';
import { docHash, pushRoute } from '../core/route';
import { contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, btnEdit, btnSave, btnCancel } from '../core/dom-refs';
import { currentFile, setCurrentFile, currentView, editMode, isServerMode } from '../core/state';
import { editor } from '../editor/editor';
import { pins } from '../graph/pins';
import { toast } from '../ui/toast';
import { renderSkeleton } from './skeleton';
import { toc, readingTimeFromWords } from './toc';
import { historyPanel } from './history-panel';
import { contentTree, loadContent, rememberContent } from './content-tree';
import { docLabel } from '../core/tree';
import { frameRenderer } from './frames';
import { stripFrontmatter, docTags } from './tags';
import { markdown } from './markdown';
import { attachCopyButtons, highlightFirstMatch } from './content-decorators';
import { taskCheckboxes } from './task-checkboxes';
import { renderBacklinksFor } from './backlinks';
import { notesPanel } from './notes/notes-panel';
import { quoteMarks } from './quote-marks';

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico'];
const VIEWABLE_EXTS = new Set(['.md', '.html', '.pdf', '.docx', '.json', ...IMAGE_EXTS]);

// What DocRenderer.show displays; any other file in the tree is a plain link to it.
export function isViewable(ext: string): boolean {
  return VIEWABLE_EXTS.has(ext);
}

// Whether this viewer may write the doc: a .md served by Atlas, outside the read-only mirrors of other
// atlases and the read-only shared view. The Edit button, the `e` shortcut, the tag chips and the task
// checkboxes all ask it.
export function canEdit(file: FileNode | null): file is FileNode {
  return !!file && file.ext === '.md' && isServerMode && !window.__viewerMode && !file.path.startsWith('remotes/');
}

export class DocRenderer {
  // Open a doc as a page of its own: Back returns to the one before.
  open(file: FileNode, highlightQuery?: string): Promise<void> {
    pushRoute(docHash(file.path));

    return this.show(file, highlightQuery);
  }

  // THE document renderer that owns #content. Writes the skeleton, gates the breadcrumb chrome,
  // dispatches by extension (.html/.pdf/.docx → an isolated frame, else the markdown pipeline) and
  // fires the post-render hooks. async: a slow load is raced out by the currentView() guards.
  async show(file: FileNode, highlightQuery?: string): Promise<void> {
    if (editMode) editor.leaveEditMode();
    setCurrentFile(file);
    const view = currentView();
    // Reset the overrides set by HTML rendering (cf. renderHtmlFrame): a .md doc after a .html must
    // get back the prose width/padding, and the todos widget (hidden during the preview) reappears.
    contentEl.style.maxWidth = '';
    contentEl.style.padding = '';
    document.getElementById('todo-widget')?.classList.remove('hidden');
    contentEl.innerHTML = renderSkeleton(file);
    // Breadcrumb: its folders, then the doc by its title; « remotes/ » reads « Mental nodes / ».
    const folders = file.path.slice(0, file.path.lastIndexOf('/') + 1);

    breadcrumbPath.textContent =
      (folders.startsWith('remotes/') ? t('remotesLabel') + ' / ' + folders.slice('remotes/'.length) : folders) +
      docLabel(file);
    breadcrumbPath.title = file.path;
    const parts: string[] = [];

    if (file.mtime) parts.push(t('modifiedAgo', relativeDate(file.mtime)));
    const rt = readingTimeFromWords(file.words);

    if (rt) parts.push(t('readingTime', rt.minutes, rt.words.toLocaleString(LANG)));
    breadcrumbDate.textContent = parts.length ? '· ' + parts.join(' · ') : '';
    breadcrumbActions.classList.remove('hidden');
    breadcrumbActions.classList.add('flex');
    // Mirror doc (under remotes/) = read-only mental node of another atlas: no Edit (write → 403),
    // no Share (don't re-share others' content), no ⋯ menu (rename/move/delete → 403).
    const isRemoteDoc = (file.path || '').startsWith('remotes/');

    btnEdit.classList.toggle('hidden', !canEdit(file));
    btnSave.classList.add('hidden');
    btnCancel.classList.add('hidden');
    document.getElementById('btn-share')?.classList.toggle('hidden', isRemoteDoc);
    document.getElementById('btn-access')?.classList.toggle('hidden', isRemoteDoc || IS_OFFLINE_BUILD);
    document.getElementById('btn-more-wrap')?.classList.toggle('hidden', isRemoteDoc);
    // "Shared by" badge: if this doc is owned by someone else (shared WITH you), surface who shared
    // it inline. Fire-and-forget; cloud-only; guarded against a stale response after navigating away.
    const sharedByEl = document.getElementById('breadcrumb-sharedby');
    if (sharedByEl) {
      sharedByEl.textContent = '';
      sharedByEl.title = '';
      if (location.protocol.startsWith('http') && !isRemoteDoc && !IS_OFFLINE_BUILD) {
        fetch('/api/acl?path=' + encodeURIComponent(file.path))
          .then((r) => (r.ok ? r.json() : null))
          .then((a) => {
            if (a && a.owner && !a.can_manage && currentFile && currentFile.path === file.path) {
              const who = String(a.owner).replace(/^user:/, '');
              sharedByEl.textContent = ' ' + t('sharedByLabel', who.split('@')[0]);
              sharedByEl.title = t('sharedByLabel', who);
            }
          })
          .catch(() => {});
      }
    }
    // Remote node actions: only on a mirror doc, never offline (no server to appropriate/remove
    // against — the buttons would 404).
    const showNodeActions = isRemoteDoc && !IS_OFFLINE_BUILD;

    document.getElementById('btn-node-appropriate')?.classList.toggle('hidden', !showNodeActions);
    document.getElementById('btn-node-remove')?.classList.toggle('hidden', !showNodeActions);
    // Download button label = the doc's actual extension (.md/.html/.pdf/.docx).
    const dlExt = document.getElementById('btn-download-ext');

    if (dlExt) dlExt.textContent = file.ext || '';
    // Close any history panel left open from the previous doc so it never shows stale revisions; the
    // button itself is gated by historyAvailable().
    historyPanel.close();
    document.getElementById('btn-history')?.classList.toggle('hidden', !historyPanel.available(file));
    pins.updateButton(file);
    // Active highlight + ancestor-open are derived from currentFile by content-tree.ts (active when
    // path matches; its folders opened once for it), so a rerender off the new currentFile
    // replaces the old imperative .active / .hidden / .caret poke and can't drift from the tree.
    contentTree.rerender();
    document.querySelector('main')!.scrollTop = 0;

    // .html document → standalone render in an isolated iframe, no markdown pipeline.
    if (file.ext === '.html') {
      frameRenderer.renderHtml(file);

      return;
    }

    // .pdf document → browser's native viewer in an iframe, no markdown.
    if (file.ext === '.pdf') {
      frameRenderer.renderPdf(file);

      return;
    }

    // Word document → converted to readable HTML in the browser (read-only).
    if (file.ext === '.docx') {
      frameRenderer.renderDocx(file);

      return;
    }

    if (IMAGE_EXTS.includes(file.ext)) {
      frameRenderer.renderImage(file);

      return;
    }

    if (file.ext === '.json') {
      frameRenderer.renderJson(file);

      return;
    }

    let content: string;

    try {
      content = await loadContent(file);
    } catch (e) {
      if (currentView() !== view) return;
      contentEl.innerHTML =
        '<div class="text-rose-400 text-sm">' + escapeHtml(t('loadError', (e as Error).message)) + '</div>';

      return;
    }

    if (currentView() !== view) return;
    const body = stripFrontmatter(content);

    contentEl.innerHTML = docTags.renderDocTags(file) + markdown.render(body, file.path);
    attachCopyButtons();
    taskCheckboxes.wireTaskCheckboxes(file, content);
    renderBacklinksFor(file);
    toc.buildToc();
    notesPanel.renderNotesFor(file);
    void quoteMarks.decorate(file);
    // Extensions hook: the doc has just been rendered (path + markdown without frontmatter).
    // Extensions listen to decorate / track the current doc.
    document.dispatchEvent(
      new CustomEvent('atlas:doc-rendered', { detail: { path: file.path, markdown: body } }),
    );

    if (highlightQuery) highlightFirstMatch(contentEl, highlightQuery);
  }

  // Render the open doc again where the reader is (a live reload, a conflict): no jump to the top.
  async rerender(file: FileNode): Promise<void> {
    const main = document.querySelector('main')!;
    const top = main.scrollTop;

    await this.show(file);
    main.scrollTop = top;
  }

  // A write was refused because the doc changed since it was shown (an AI edit, another device):
  // show its current text and say so, rather than write over it.
  async reloadChanged(file: FileNode, current: string): Promise<void> {
    rememberContent(file, current);
    toast(t('docChangedReloaded'));
    if (currentFile && currentFile.path === file.path) await this.rerender(file);
  }
}

export const docRenderer = new DocRenderer();
