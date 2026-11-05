// Document editor exposed as the `editor` singleton: the chrome buttons trigger edit mode, the
// command palette (graph/command-palette.ts) and keyboard router (graph/keyboard-router.ts) call
// enterEditMode, while the doc renderer (content/doc-renderer.ts) and tag browser
// (content/tag-browse.ts) call leaveEditMode when leaving a doc.
//
// Editor owns the markdown toolbar and the split-view edit mode (textarea + live preview, one at a
// time on a phone). The split UI is built imperatively and the debounced preview rewrite touches
// ONLY #md-preview — the #md-editor textarea is never recreated, so caret / focus survive
// (golden E). Kept imperative on purpose: no vDOM reconciliation here. The [[wikilink]] autocomplete is composed in from
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
import { fileMap } from '../core/tree';
import { mdInsertWrap, mdInsertLineStart, mdInsertAtCursor, stripFrontmatter } from '../content/tags';
import { loadContent, putDoc, rememberContent } from '../content/content-tree';
import { Dialogs } from '../modals/dialogs';
import { markdown } from '../content/markdown';
import { canEdit, docRenderer } from '../content/doc-renderer';
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
    '">' +
    t('tbTodoLabel') +
    '</button>' +
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
    '">' +
    t('tbTableLabel') +
    '</button>' +
    '<button data-md="hr" class="md-tb-btn" title="' +
    t('tbHr') +
    '">' +
    t('tbHrLabel') +
    '</button>';

  // The split-view live-preview debounce timer, cleared on exit. The [[wikilink]] popup, its caret
  // measurement, and its own timers/listeners live in the composed WikilinkAutocomplete.
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private wikilink = new WikilinkAutocomplete();
  // The text the session started from: sent with the save so the server refuses (409) to overwrite
  // a doc that changed meanwhile, and compared with the textarea to know if anything would be lost.
  private editBase = '';

  constructor() {
    btnEdit.addEventListener('click', () => this.enterEditMode());
    btnSave.addEventListener('click', () => this.saveEdit());
    btnCancel.addEventListener('click', () => this.cancelEdit());
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges()) e.preventDefault();
    });
  }

  private hasUnsavedChanges(): boolean {
    return editMode && editTextarea !== null && editTextarea.value !== this.editBase;
  }

  // ---- local draft: an unsaved edit survives a closed tab, a crash or a click elsewhere ----
  private static readonly DRAFT_KEY = 'atlas-draft:';

  private static readDraft(path: string): string | null {
    try {
      return localStorage.getItem(Editor.DRAFT_KEY + path);
    } catch (e) {
      return null;
    }
  }

  private static writeDraft(path: string, text: string | null): void {
    try {
      if (text === null) localStorage.removeItem(Editor.DRAFT_KEY + path);
      else localStorage.setItem(Editor.DRAFT_KEY + path, text);
    } catch (e) {
      /* storage blocked or full: the beforeunload guard still protects the open tab */
    }
  }

  private async cancelEdit(): Promise<void> {
    if (
      this.hasUnsavedChanges() &&
      !(await Dialogs.confirm({
        title: t('discardTitle'),
        message: t('discardMessage'),
        confirmLabel: t('discardConfirm'),
        destructive: true,
      }))
    )
      return;
    if (currentFile) Editor.writeDraft(currentFile.path, null);
    this.exitEditMode();
  }

  // The preview shows the doc as it will read: no frontmatter, no language guessing (see Markdown).
  private static preview(text: string, path: string): string {
    return markdown.render(stripFrontmatter(text), path, true);
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
    if (editMode || !canEdit(currentFile)) return;
    // Make sure we have the content before switching to edit mode.
    let content: string;

    try {
      content = await loadContent(currentFile);
    } catch (e) {
      Dialogs.notifyError('cantLoadDoc', (e as Error).message);

      return;
    }

    const path = currentFile.path;
    const draft = Editor.readDraft(path);

    this.editBase = content;
    if (draft !== null && draft !== content) {
      const restore = await Dialogs.confirm({
        title: t('draftRestoreTitle'),
        message: t('draftRestoreMessage'),
        confirmLabel: t('draftRestore'),
        cancelLabel: t('draftDiscard'),
      });

      if (restore) content = draft;
      else Editor.writeDraft(path, null);
    }

    setEditMode(true);
    contentEl.classList.remove('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
    contentEl.classList.add('max-w-none', 'px-4', 'py-4');

    const wrap = document.createElement('div');

    wrap.className = 'md-edit flex flex-col';

    // On a phone the two panes don't fit side by side: one at a time, Write or Preview.
    const modes = document.createElement('div');

    modes.className = 'md-modes nf-seg';
    modes.innerHTML =
      '<button type="button" class="nf-seg-btn active" data-pane="write">' + t('editWrite') + '</button>' +
      '<button type="button" class="nf-seg-btn" data-pane="preview">' + t('editPreview') + '</button>';

    const toolbar = document.createElement('div');

    toolbar.className =
      'flex flex-wrap items-center gap-1 px-3 py-2 border subtle-border rounded-t-md bg-navy-800';
    toolbar.innerHTML = Editor.MD_TOOLBAR_HTML;

    const splitWrap = document.createElement('div');

    splitWrap.className =
      'md-split flex flex-1 min-h-0 border-l border-r border-b subtle-border rounded-b-md overflow-hidden bg-navy-900';

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

    const previewEl = document.createElement('article');

    previewEl.id = 'md-preview';
    previewEl.className =
      'min-w-0 px-8 py-6 overflow-y-auto scrollbar-thin prose prose-sm prose-invert max-w-none';
    previewEl.style.flex = '1 1 0';
    previewEl.innerHTML = Editor.preview(content, path);

    splitWrap.appendChild(ta);
    splitWrap.appendChild(divider);
    splitWrap.appendChild(previewEl);

    wrap.appendChild(modes);
    wrap.appendChild(toolbar);
    wrap.appendChild(splitWrap);

    contentEl.innerHTML = '';
    contentEl.appendChild(wrap);

    toolbar.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('[data-md]');

      if (btn) this.mdHandleAction((btn as HTMLElement).dataset.md as string);
    });
    modes.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest('[data-pane]') as HTMLElement | null;

      if (!btn) return;
      const preview = btn.dataset.pane === 'preview';

      if (preview) previewEl.innerHTML = Editor.preview(ta.value, path);
      splitWrap.classList.toggle('show-preview', preview);
      modes.querySelectorAll('[data-pane]').forEach((b) => b.classList.toggle('active', b === btn));
    });

    this.wikilink.resetCandidates(); // candidates recompute on the 1st keystroke (catches new docs)

    ta.addEventListener('input', () => {
      this.wikilink.update();
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => {
        previewEl.innerHTML = Editor.preview(ta.value, path);
      }, 150);
      if (this.draftTimer) clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => {
        Editor.writeDraft(path, ta.value === this.editBase ? null : ta.value);
      }, 400);
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
      const res = await putDoc({ path: file.path, content: newContent, base_content: this.editBase });

      if (!res.ok) {
        await this.keepBoth(file, newContent, res.current);

        return;
      }
      Editor.writeDraft(file.path, null);
      file.mtime = res.mtime;
      rememberContent(file, newContent);
      // Neutralize the live-reload SSE that follows the commit, to avoid a 2nd
      // re-render (flash) on top of the one done when exiting edit mode. Same trick
      // as the checkboxes.
      sse.muteSelfSave(file.path);
      this.exitEditMode();
    } catch (e) {
      Dialogs.notifyError('err', (e as Error).message);
    } finally {
      (btnSave as HTMLButtonElement).disabled = false;
      btnSave.textContent = t('saveBtn');
    }
  }

  // The doc changed since the session opened it (an AI edit, another tab): never overwrite it.
  // Keep both — this version goes next to it as a new doc — or go back to editing.
  private async keepBoth(file: FileNode, mine: string, current: string): Promise<void> {
    const copy = Editor.copyPath(file.path);
    const copyName = copy.slice(copy.lastIndexOf('/') + 1);
    const keep = await Dialogs.confirm({
      title: t('conflictTitle'),
      message: t('conflictMessage', copyName),
      confirmLabel: t('conflictKeepBoth'),
      cancelLabel: t('conflictKeepEditing'),
    });

    if (!keep) return;
    await putDoc({ path: copy, content: mine }); // a new doc: nothing to conflict with
    Editor.writeDraft(file.path, null);
    rememberContent(file, current);
    this.exitEditMode();
    Dialogs.alert({ title: t('conflictTitle'), message: t('conflictSavedAs', copyName) });
  }

  // "notes/x.md" → "notes/x (my version).md", numbered when that name is already taken.
  private static copyPath(path: string): string {
    const dot = path.lastIndexOf('.');
    const stem = path.slice(0, dot);
    const ext = path.slice(dot);

    for (let n = 1; ; n++) {
      const candidate = stem + ' (' + t('myVersionSuffix') + (n > 1 ? ' ' + n : '') + ')' + ext;

      if (!fileMap[candidate]) return candidate;
    }
  }

  // Back to reading the doc, through the normal rendering (frontmatter off, tags, notes, links). Its
  // text is in hand (saved, or the one the session started from), so nothing is fetched.
  exitEditMode(): void {
    this.leaveEditMode();
    if (currentFile) void docRenderer.show(currentFile);
  }

  // Leave the session for another page: tear it down, the next page renders itself.
  leaveEditMode(): void {
    this.teardownEditSession();
    setEditMode(false);
    setEditTextarea(null);
    contentEl.classList.add('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
    contentEl.classList.remove('max-w-none', 'px-4', 'py-4');
  }

  // Clear the live-preview timer and tear down the wikilink popup so nothing survives the session.
  private teardownEditSession(): void {
    this.wikilink.teardown();

    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    // Dropped, not flushed: after a save or a discard the draft is already gone and must stay so.
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
  }
}

export const editor = new Editor();
