// The document renderer. DocRenderer.show owns #content: it writes the skeleton, gates the breadcrumb
// chrome, dispatches by extension (.html/.pdf/.docx → an isolated frame, else the markdown pipeline)
// and fires the post-render hooks. The DOM is written exactly as before (innerHTML/createElement/
// appendChild) — no reconciliation refactor — so the goldens stay byte-stable; the one structural
// change is that the tree's active/ancestor-open highlight is derived by 02-content-tree via
// contentTree.rerender() instead of an imperative DOM poke. showMarkdown stays a shared top-level
// global (cross-module callers reference it by name). The anti-race guards stay object-identity
// (currentFile !== file): a slow load for doc A must not clobber doc B.

import { IS_OFFLINE_BUILD } from '../core/data-csrf';
import { LANG, t } from '../core/i18n';
import { escapeHtml, relativeDate } from '../core/utils';
import { contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, btnEdit, btnSave, btnCancel } from '../core/dom-refs';
import { currentFile, setCurrentFile, editMode } from '../core/state';
import { editor } from '../editor/editor';
import { pins } from '../graph/pins';
import { renderSkeleton } from './skeleton';
import { toc, readingTimeFromWords } from './toc';
import { historyPanel } from './history-panel';
import { contentTree, loadContent } from './content-tree';
import { frameRenderer } from './frames';
import { stripFrontmatter, docTags } from './tags';
import { markdown } from './markdown';
import { attachCopyButtons, highlightFirstMatch } from './content-decorators';
import { taskCheckboxes } from './task-checkboxes';
import { renderBacklinksFor } from './backlinks';
import { notesPanel } from './notes/notes-panel';

export class DocRenderer {
  // THE document renderer that owns #content. Writes the skeleton, gates the breadcrumb chrome,
  // dispatches by extension (.html/.pdf/.docx → an isolated frame, else the markdown pipeline) and
  // fires the post-render hooks. async: a slow load is raced out by the currentFile !== file guards.
  async show(file: FileNode, highlightQuery?: string): Promise<void> {
    if (editMode) editor.exitEditMode(false);
    setCurrentFile(file);
    // Reset the overrides set by HTML rendering (cf. renderHtmlFrame): a .md doc after a .html must
    // get back the prose width/padding, and the todos widget (hidden during the preview) reappears.
    contentEl.style.maxWidth = '';
    contentEl.style.padding = '';
    document.getElementById('todo-widget')?.classList.remove('hidden');
    contentEl.innerHTML = renderSkeleton(file);
    // Breadcrumb: replace the technical prefix « remotes/ » with the « Mental nodes / » label.
    breadcrumbPath.textContent = file.path.startsWith('remotes/')
      ? t('remotesLabel') + ' / ' + file.path.slice('remotes/'.length)
      : file.path;
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

    btnEdit.classList.toggle('hidden', isRemoteDoc);
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
    // Active highlight + ancestor-open are derived from currentFile by 02-content-tree (active when
    // path matches; ancestors open via its startsWith clause), so a rerender off the new currentFile
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

    let content: string;

    try {
      content = await loadContent(file);
    } catch (e) {
      if (currentFile !== file) return;
      contentEl.innerHTML =
        '<div class="text-rose-400 text-sm">' + escapeHtml(t('loadError', (e as Error).message)) + '</div>';

      return;
    }

    if (currentFile !== file) return;
    const body = stripFrontmatter(content);

    contentEl.innerHTML = docTags.renderDocTags(file) + markdown.render(body);
    attachCopyButtons();
    taskCheckboxes.wireTaskCheckboxes(file, content);
    renderBacklinksFor(file);
    toc.buildToc();
    notesPanel.renderNotesFor(file);
    // Extensions hook: the doc has just been rendered (path + markdown without frontmatter).
    // Extensions listen to decorate / track the current doc.
    document.dispatchEvent(
      new CustomEvent('atlas:doc-rendered', { detail: { path: file.path, markdown: body } }),
    );

    if (highlightQuery) highlightFirstMatch(contentEl, highlightQuery);
  }
}

export const docRenderer = new DocRenderer();
