// The "all docs with #tag" browse page: an imperative innerHTML render of #content. It stays
// imperative (like the doc-tag chips in 08-tags) because the content area is still owned by
// showMarkdown (06-view-history); routing it through the runtime's render() would leave that
// container's ROOTS map stale and corrupt the next diff. Reached from a tag-chip click (08-tags'
// content delegation), the graph's tag nodes (12) and the home tag rows (10), all through the
// top-level showTag wrapper. Self-contained: it shares no state with the tag-editing pieces.

import { t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { fileMap } from '../core/tree';
import { contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, tocPanel } from '../core/dom-refs';
import { editMode, setCurrentFile } from '../core/state';
import { editor } from '../editor/editor';
import { docRenderer } from './doc-renderer';

export class TagBrowsePage {
  showTag(tag: string): void {
    if (editMode) editor.exitEditMode(false);
    setCurrentFile(null);
    document.querySelector('main')!.scrollTop = 0;
    const docs = Object.values(fileMap)
      .filter((f) => f.ext === '.md' && (f.tags || []).includes(tag))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    let html =
      '<h1 class="!mb-1">#' +
      escapeHtml(tag) +
      '</h1>' +
      '<p class="lead text-ink-400 !mt-0">' +
      t('docsWithTag', docs.length) +
      '</p>' +
      '<ul class="not-prose mt-6 space-y-2">';

    for (const f of docs) {
      html +=
        '<li><a class="block p-3 bg-black/20 hover:bg-black/30 border subtle-border rounded-lg cursor-pointer transition" data-tagdoc="' +
        escapeHtml(f.path) +
        '">' +
        '<div class="text-sm text-ink-100 font-medium font-sans truncate">' +
        escapeHtml(f.name) +
        '</div>' +
        '<div class="text-[10px] text-ink-500 mt-0.5 font-mono truncate">' +
        escapeHtml(f.path) +
        '</div></a></li>';
    }

    contentEl.innerHTML = html + '</ul>';
    contentEl.querySelectorAll('[data-tagdoc]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const f = fileMap[(a as HTMLElement).dataset.tagdoc!];

        if (f) {
          docRenderer.show(f);
          history.replaceState(null, '', '#' + encodeURIComponent(f.path));
        }
      }),
    );
    breadcrumbPath.textContent = '#' + tag;
    breadcrumbDate.textContent = '';
    breadcrumbActions.classList.add('hidden');
    breadcrumbActions.classList.remove('flex');
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    document.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
  }
}

export const tagBrowsePage = new TagBrowsePage();
