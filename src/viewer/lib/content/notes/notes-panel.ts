// Passage-notes side panel (#toc-notes): the per-doc list of annotations, plus renderNotesFor — the
// pipeline that fetches the notes (notesStore), resolves + highlights each anchor (noteAnchor) and
// renders the rows. renderNotesFor is called by DocRenderer.show (doc-renderer.ts).
//
// noteContext is the one mutable seam the note pieces share: NotesPanel fills notesForDoc here during
// the resolve pass; notesStore.copyAllNotes reads it for the markdown export.

import { t } from '../../core/i18n';
import { escapeHtml, relativeDate } from '../../core/utils';
import { tocNotes, contentEl } from '../../core/dom-refs';
import { currentFile, tocHasNotes, setTocHasNotes } from '../../core/state';
import { layoutChrome } from '../../home/layout-chrome';
import { noteAnchor } from './note-anchor';
import { notePopover } from './note-popover';
import { notesStore } from './notes-store';

// Current doc's resolved annotations (anchors resolved against the rendered DOM on the fly).
export const noteContext: { notesForDoc: NoteResolved[] } = { notesForDoc: [] };

export class NotesPanel {
  private static readonly NOTES_COPY_ICON =
    '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg>';

  async renderNotesFor(file: FileNode): Promise<void> {
    setTocHasNotes(false);

    if (tocNotes) {
      tocNotes.innerHTML = '';
      tocNotes.classList.remove('border-t', 'panel-divider');
    }

    noteContext.notesForDoc = [];
    // _orphan is filled by the resolve loop below before renderNotesPanel reads it.
    const notes = (await notesStore.fetchNotes(file)) as NoteResolved[];

    if (currentFile !== file) return; // page changed during the fetch
    noteContext.notesForDoc = notes;

    if (!notes.length) {
      layoutChrome.applyToc();

      return;
    }

    // Resolve each anchor in the rendered DOM and highlight it.
    notes.forEach((note) => {
      const loc = noteAnchor.locateAnchor(note);

      note._orphan = !(
        loc &&
        noteAnchor.highlightRange(loc.start, loc.end, note, (n, mark) =>
          notePopover.openNotePopForExisting(n, mark),
        )
      );
    });
    this.renderNotesPanel();
  }

  private renderNotesPanel(): void {
    setTocHasNotes(noteContext.notesForDoc.length > 0);
    tocNotes.classList.toggle('hidden', !tocHasNotes); // empty section → no gap

    if (!tocHasNotes) {
      layoutChrome.applyToc();

      return;
    }

    const row = (note: NoteResolved): string => {
      const by = note.author ? '✍ ' + escapeHtml(String(note.author).split('@')[0]) : '';
      const when = note.created ? relativeDate(note.created) : '';
      const byline = [by, when].filter(Boolean).join(' · ');
      return (
        '<button class="kb-note-row' +
        (note._orphan ? ' kb-orphan' : '') +
        '" data-note-id="' +
        escapeHtml(note.id) +
        '">' +
        '<span class="kb-note-snip">' +
        escapeHtml(note.note.length > 90 ? note.note.slice(0, 90) + '…' : note.note) +
        '</span>' +
        '<span class="kb-note-meta">' +
        (note._orphan
          ? t('orphanShort')
          : '“' +
            escapeHtml(note.exact.length > 40 ? note.exact.slice(0, 40) + '…' : note.exact) +
            '”') +
        '</span>' +
        (byline
          ? '<span class="kb-note-meta" style="opacity:.65">' + byline + '</span>'
          : '') +
        '</button>'
      );
    };

    tocNotes.classList.add('border-t', 'panel-divider');
    // Header with counter + « copy all notes » button (share annotations, incl. from a read-only
    // remote node).
    tocNotes.innerHTML =
      '<div class="px-2 pb-1 flex items-center justify-between gap-2">' +
      '<span class="text-[10px] uppercase tracking-[0.12em] text-amber-300 font-bold">' +
      t('notesTitle', noteContext.notesForDoc.length) +
      '</span>' +
      '<button id="toc-notes-copy" class="p-0.5 -mr-0.5 text-ink-500 hover:text-amber-300 rounded hover:bg-white/5 flex-shrink-0" title="' +
      escapeHtml(t('copyAllNotes')) +
      '">' +
      NotesPanel.NOTES_COPY_ICON +
      '</button>' +
      '</div>' +
      noteContext.notesForDoc.map(row).join('');
    const copyBtn = tocNotes.querySelector('#toc-notes-copy');

    if (copyBtn)
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notesStore.copyAllNotes(copyBtn);
      });
    tocNotes.querySelectorAll('[data-note-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const note = noteContext.notesForDoc.find((n) => n.id === (el as HTMLElement).dataset.noteId);

        if (!note) return;
        const mark = contentEl.querySelector(
          'mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]',
        );

        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          notePopover.openNotePopForExisting(note, mark);
        } else notePopover.openNotePopForExisting(note, el); // orphan: anchor the popover on the row
      });
    });
    layoutChrome.applyToc();
  }
}

export const notesPanel = new NotesPanel();
