// Document editor exposed as the `editor` singleton: the chrome buttons trigger edit mode, the
// command palette (graph/command-palette.ts) and keyboard router (graph/keyboard-router.ts) call
// enterEditMode, while the doc renderer (content/doc-renderer.ts) and tag browser
// (content/tag-browse.ts) call exitEditMode when leaving a doc.
//
// Editor owns the markdown toolbar and the split-view edit mode (textarea + live preview). The split
// UI is built imperatively and the debounced preview rewrite touches ONLY #md-preview — the
// #md-editor textarea is never recreated, so caret / focus survive (golden E). Kept imperative on
// purpose: no vDOM reconciliation here. The [[wikilink]] autocomplete is composed in from
// WikilinkAutocomplete (./wikilink-autocomplete); full-text search is its own concern in ./search.

import { t } from '../core/i18n';
import { WikilinkAutocomplete } from './wikilink-autocomplete';
import { btnEdit, btnSave, btnCancel, contentEl, tocPanel } from '../core/dom-refs';
import {
  editMode,
  setEditMode,
  editTextarea,
  setEditTextarea,
  currentFile,
  isServerMode,
} from '../core/state';
import { mdInsertWrap, mdInsertLineStart, mdInsertAtCursor } from '../content/tags';
import { loadContent, contentCache } from '../content/content-tree';
import { Dialogs } from '../modals/dialogs';
import { markdown } from '../content/markdown';
import { docRenderer } from '../content/doc-renderer';
import { attachCopyButtons } from '../content/content-decorators';
import { taskCheckboxes } from '../content/task-checkboxes';
import { renderBacklinksFor } from '../content/backlinks';
import { toc } from '../content/toc';
import { sse } from '../core/sse-coord';
import { tocShow } from '../home/layout-chrome';

export class Editor {
  // ---- markdown toolbar ----
  // Built once when this module is first evaluated; the strings are localized via t(), so core/i18n
  // must already be evaluated — the import guarantees that ordering.
  private static readonly MD_TOOLBAR_HTML =
    '' +
    '<button data-md="bold" class="md-tb-btn" title="' +
    t('tbBold') +
    '"><b>B</b></button>' +
    '<button data-md="italic" class="md-tb-btn" title="' +
    t('tbItalic') +
    '"><i>I</i></button>' +
    '<button data-md="strike" class="md-tb-btn" title="' +
    t('tbStrike') +
    '"><s>S</s></button>' +
    '<span class="md-tb-sep"></span>' +
    '<button data-md="h1" class="md-tb-btn">H1</button>' +
    '<button data-md="h2" class="md-tb-btn">H2</button>' +
    '<button data-md="h3" class="md-tb-btn">H3</button>' +
    '<span class="md-tb-sep"></span>' +
    '<button data-md="ul" class="md-tb-btn" title="' +
    t('tbUl') +
    '">' +
    t('tbUlLabel') +
    '</button>' +
    '<button data-md="ol" class="md-tb-btn" title="' +
    t('tbOl') +
    '">' +
    t('tbOlLabel') +
    '</button>' +
    '<button data-md="todo" class="md-tb-btn" title="' +
    t('tbTodo') +
    '">☐ Todo</button>' +
    '<button data-md="quote" class="md-tb-btn" title="' +
    t('tbQuote') +
    '">' +
    t('tbQuoteLabel') +
    '</button>' +
    '<span class="md-tb-sep"></span>' +
    '<button data-md="link" class="md-tb-btn" title="' +
    t('tbLink') +
    '">' +
    t('tbLinkLabel') +
    '</button>' +
    '<button data-md="code" class="md-tb-btn" title="' +
    t('tbCode') +
    '">&lt;/&gt;</button>' +
    '<button data-md="codeblock" class="md-tb-btn" title="' +
    t('tbCodeblock') +
    '">' +
    t('tbCodeblockLabel') +
    '</button>' +
    '<button data-md="table" class="md-tb-btn" title="' +
    t('tbTable') +
    '">⊞ Table</button>' +
    '<button data-md="hr" class="md-tb-btn" title="' +
    t('tbHr') +
    '">— HR</button>';

  // The split-view live-preview debounce timer, cleared on exit. The [[wikilink]] popup, its caret
  // measurement, and its own timers/listeners live in the composed WikilinkAutocomplete.
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private wikilink = new WikilinkAutocomplete();

  constructor() {
    btnEdit.addEventListener('click', () => this.enterEditMode());
    btnSave.addEventListener('click', () => this.saveEdit());
    btnCancel.addEventListener('click', () => this.exitEditMode(false));
  }

  private mdHandleAction(action: string): void {
    const ta = editTextarea;

    if (!ta) return;
    ta.focus();

    switch (action) {
      case 'bold':
        mdInsertWrap('**', '**', t('phText'));
        break;
      case 'italic':
        mdInsertWrap('*', '*', t('phText'));
        break;
      case 'strike':
        mdInsertWrap('~~', '~~', t('phText'));
        break;
      case 'h1':
        mdInsertLineStart('# ');
        break;
      case 'h2':
        mdInsertLineStart('## ');
        break;
      case 'h3':
        mdInsertLineStart('### ');
        break;
      case 'ul':
        mdInsertLineStart('- ');
        break;
      case 'ol':
        mdInsertLineStart('1. ');
        break;
      case 'todo':
        mdInsertLineStart('- [ ] ');
        break;
      case 'quote':
        mdInsertLineStart('> ');
        break;
      case 'link':
        mdInsertWrap('[', '](url)', t('phLabel'));
        break;
      case 'code':
        mdInsertWrap('`', '`', 'code');
        break;
      case 'codeblock':
        mdInsertWrap('\n```\n', '\n```\n', 'code');
        break;
      case 'hr':
        mdInsertAtCursor('\n\n---\n\n');
        break;
      case 'table':
        mdInsertAtCursor('\n| Col 1 | Col 2 |\n| --- | --- |\n| A | B |\n');
        break;
    }
  }

  // ---- edit-mode lifecycle ----
  async enterEditMode(): Promise<void> {
    if (!currentFile) return;
    // Make sure we have the content before switching to edit mode.
    let content: string;

    try {
      content = await loadContent(currentFile);
    } catch (e) {
      Dialogs.notifyError('cantLoadDoc', (e as Error).message);

      return;
    }

    setEditMode(true);
    contentEl.classList.remove('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
    contentEl.classList.add('max-w-none', 'px-4', 'py-4');

    const wrap = document.createElement('div');

    wrap.className = 'flex flex-col';
    wrap.style.height = 'calc(100vh - 11rem)';

    const toolbar = document.createElement('div');

    toolbar.className =
      'flex flex-wrap items-center gap-1 px-3 py-2 border subtle-border rounded-t-md bg-navy-800';
    toolbar.innerHTML = Editor.MD_TOOLBAR_HTML;

    const splitWrap = document.createElement('div');

    splitWrap.className =
      'flex flex-1 min-h-0 border-l border-r border-b subtle-border rounded-b-md overflow-hidden bg-navy-900';

    const ta = document.createElement('textarea');

    ta.id = 'md-editor';
    ta.value = content;
    ta.spellcheck = false;
    ta.className =
      'min-w-0 p-5 bg-transparent text-ink-100 resize-none focus:outline-none scrollbar-thin';
    ta.style.flex = '1 1 0';
    setEditTextarea(ta);

    const divider = document.createElement('div');

    divider.className = 'w-px bg-[#2a2a32] flex-shrink-0';

    const preview = document.createElement('article');

    preview.id = 'md-preview';
    preview.className =
      'min-w-0 px-8 py-6 overflow-y-auto scrollbar-thin prose prose-sm prose-invert max-w-none';
    preview.style.flex = '1 1 0';
    preview.innerHTML = markdown.render(content);

    splitWrap.appendChild(ta);
    splitWrap.appendChild(divider);
    splitWrap.appendChild(preview);

    wrap.appendChild(toolbar);
    wrap.appendChild(splitWrap);

    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    toolbar.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('[data-md]');

      if (btn) this.mdHandleAction((btn as HTMLElement).dataset.md as string);
    });

    this.wikilink.resetCandidates(); // candidates recompute on the 1st keystroke (catches new docs)

    ta.addEventListener('input', () => {
      this.wikilink.update();
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => {
        preview.innerHTML = markdown.render(ta.value);
      }, 150);
    });
    ta.addEventListener('blur', () => {
      this.wikilink.scheduleClose();
    });
    ta.addEventListener('keydown', (e) => {
      if (this.wikilink.handleKeydown(e)) return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();

        if (k === 'b') {
          e.preventDefault();
          this.mdHandleAction('bold');

          return;
        }

        if (k === 'i') {
          e.preventDefault();
          this.mdHandleAction('italic');

          return;
        }

        if (k === 'l') {
          e.preventDefault();
          this.mdHandleAction('link');

          return;
        }
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        mdInsertAtCursor('  ');
      }
    });

    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;

    btnEdit.classList.add('hidden');
    btnSave.classList.remove('hidden');
    btnCancel.classList.remove('hidden');
    // Extensions hook: entering edit mode (hide their doc actions).
    document.dispatchEvent(new CustomEvent('atlas:edit-enter'));
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');

    if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  }

  private async saveEdit(): Promise<void> {
    if (!editMode || !currentFile) return;

    if (!isServerMode) {
      Dialogs.notifyError('fileModeNoEdit');

      return;
    }

    const file = currentFile;
    const newContent = editTextarea!.value;

    (btnSave as HTMLButtonElement).disabled = true;
    btnSave.textContent = t('saving');

    try {
      const body: FilePutBody = { path: file.path, content: newContent };
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as { mtime?: number };

      file.content = newContent;
      contentCache.set(file.path, newContent);
      file.mtime = data.mtime || Math.floor(Date.now() / 1000);
      // Neutralize the live-reload SSE that follows the commit, to avoid a 2nd
      // re-render (flash) on top of the one done when exiting edit mode. Same trick
      // as the checkboxes.
      sse.muteSelfSave(file.path);
      this.exitEditMode(true);
    } catch (e) {
      Dialogs.notifyError('err', (e as Error).message);
    } finally {
      (btnSave as HTMLButtonElement).disabled = false;
      btnSave.textContent = t('saveBtn');
    }
  }

  exitEditMode(reload?: boolean): void {
    this.teardownEditSession();
    setEditMode(false);
    setEditTextarea(null);
    contentEl.classList.add('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
    contentEl.classList.remove('max-w-none', 'px-4', 'py-4');

    if (reload && currentFile) docRenderer.show(currentFile);
    else if (currentFile) {
      btnEdit.classList.remove('hidden');
      btnSave.classList.add('hidden');
      btnCancel.classList.add('hidden');
      // Re-render from the cached content (always present since we were editing).
      const cached =
        currentFile.content != null ? currentFile.content : contentCache.get(currentFile.path);

      contentEl.innerHTML = markdown.render(cached || '');
      attachCopyButtons();
      taskCheckboxes.wireTaskCheckboxes(currentFile, cached || '');
      renderBacklinksFor(currentFile);
      toc.buildToc();
      document.dispatchEvent(
        new CustomEvent('atlas:doc-rendered', {
          detail: { path: currentFile.path, markdown: cached || '' },
        }),
      );
    }
  }

  // Clear the live-preview timer and tear down the wikilink popup so nothing survives the session.
  private teardownEditSession(): void {
    this.wikilink.teardown();

    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }
}

export const editor = new Editor();
