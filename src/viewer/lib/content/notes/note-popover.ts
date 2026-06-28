// The passage-note popover island: the floating "Note" button shown on a text selection, and the
// create / read-edit popover it opens. Owns the selection → button → popover flow and its pending
// anchor + rect; geometry is delegated to noteAnchor, persistence to notesStore. The button + popover
// are stateful DOM islands kept outside the keyed runtime, guaranteed by the viewer markup.

import { IS_OFFLINE_BUILD } from '../../core/data-csrf';
import { contentEl } from '../../core/dom-refs';
import { escapeHtml, relativeDate } from '../../core/utils';
import { t } from '../../core/i18n';
import { editMode, currentFile } from '../../core/state';
import { noteAnchor, type TextQuoteAnchor } from './note-anchor';
import { notesStore } from './notes-store';

export class NotePopover {
  // Anchor being created (selection -> popover), null when the create popover is closed.
  private pendingAnchor: TextQuoteAnchor | null = null;
  // selectionchange debounce handle.
  private selTimer: ReturnType<typeof setTimeout> | null = null;
  // Anchor + rect captured at selection time, so the "Note" button tap works after the selection
  // collapses (mobile) — was stashed on the DOM node (noteAddBtn._anchor/_rect) before.
  private pendingButtonAnchor: TextQuoteAnchor | null = null;
  private pendingButtonRect: DOMRect | null = null;

  // Stateful islands: the floating "Note" button + the popover. Guaranteed by the viewer markup.
  private readonly noteAddBtn = document.getElementById('kb-note-add')!;
  private readonly notePop = document.getElementById('kb-note-pop')!;

  constructor() {
    // Desktop: immediate mouseup. Mobile/keyboard: selectionchange (touch handles emit no mouseup)
    // debounced until the selection stabilizes — the delay also lets the button tap land before the
    // collapse clears it.
    contentEl.addEventListener('mouseup', () => setTimeout(() => this.updateNoteButton(), 10));
    document.addEventListener('selectionchange', () => {
      if (this.selTimer) clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => this.updateNoteButton(), 350);
    });
    this.noteAddBtn.addEventListener('click', () => this.triggerNoteCreate());
    // dedicated touchend: on mobile the click can be swallowed by the selection dismiss.
    this.noteAddBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.triggerNoteCreate();
    });
    document.addEventListener('mousedown', (e) => this.maybeCloseOutside(e));
    document.addEventListener('touchstart', (e) => this.maybeCloseOutside(e), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeNotePop();
        this.noteAddBtn.style.display = 'none';
      }
    });
  }

  // Notes are the (deferred) comment level — admin-only for now. A member has the `viewer-mode`
  // body class (but writes its own docs), so gate notes on the class.
  private notesCanEdit(): boolean {
    return !IS_OFFLINE_BUILD && !document.body.classList.contains('viewer-mode');
  }

  // ─── Popover create / read-edit ──────────────────────────────────────────
  private positionPop(el: HTMLElement, anchorRect: DOMRect): void {
    const margin = 8;
    let top = window.scrollY + anchorRect.bottom + margin;
    let left = window.scrollX + anchorRect.left;

    el.style.display = 'block';
    const w = el.offsetWidth;
    const ph = el.offsetHeight;

    if (left + w > window.scrollX + document.documentElement.clientWidth - margin)
      left = window.scrollX + document.documentElement.clientWidth - w - margin;

    if (anchorRect.bottom + margin + ph > document.documentElement.clientHeight)
      top = window.scrollY + anchorRect.top - ph - margin;
    el.style.top = Math.max(window.scrollY + margin, top) + 'px';
    el.style.left = Math.max(margin, left) + 'px';
  }

  closeNotePop(): void {
    this.notePop.style.display = 'none';
    this.notePop.innerHTML = '';
    this.pendingAnchor = null;
    contentEl
      .querySelectorAll('mark.kb-annot.kb-annot-active')
      .forEach((m) => m.classList.remove('kb-annot-active'));
  }

  private openNotePopForNew(anchor: TextQuoteAnchor, rect: DOMRect): void {
    this.pendingAnchor = anchor;
    this.notePop.innerHTML =
      '<div class="kb-quote">“' +
      escapeHtml(anchor.exact.length > 160 ? anchor.exact.slice(0, 160) + '…' : anchor.exact) +
      '”</div>' +
      '<textarea placeholder="' +
      escapeHtml(t('notePlaceholder')) +
      '"></textarea>' +
      '<div class="kb-pop-actions"><button class="kb-btn-ghost" data-act="cancel">' +
      t('cancel') +
      '</button><button class="kb-btn-save" data-act="save">' +
      t('save') +
      '</button></div>';
    this.positionPop(this.notePop, rect);
    const ta = this.notePop.querySelector('textarea')!;

    ta.focus();
    (this.notePop.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () =>
      this.closeNotePop();
    (this.notePop.querySelector('[data-act="save"]') as HTMLElement).onclick = () =>
      notesStore.saveNewNote(this.pendingAnchor, ta.value);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) notesStore.saveNewNote(this.pendingAnchor, ta.value);
    });
  }

  openNotePopForExisting(note: NoteResolved, anchorEl: Element): void {
    this.closeNotePop();
    contentEl
      .querySelectorAll('mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]')
      .forEach((m) => m.classList.add('kb-annot-active'));
    const canEdit = this.notesCanEdit();
    const created = note.created ? relativeDate(note.created) : '';
    const by = note.author ? '✍ ' + escapeHtml(String(note.author).split('@')[0]) : '';
    const meta = [by, created].filter(Boolean).join(' · ');

    this.notePop.innerHTML =
      (note._orphan
        ? '<div class="kb-quote">' + t('orphanLong', escapeHtml(note.exact.slice(0, 120))) + '</div>'
        : '') +
      (canEdit
        ? '<textarea>' + escapeHtml(note.note) + '</textarea>'
        : '<div style="font-size:0.82rem;color:#e7e7ec;white-space:pre-wrap">' +
          escapeHtml(note.note) +
          '</div>') +
      (meta
        ? '<div class="kb-note-meta" style="font-size:0.66rem;color:#6b7280;margin-top:0.5rem">' +
          meta +
          '</div>'
        : '') +
      '<div class="kb-pop-actions">' +
      (canEdit ? '<button class="kb-btn-del" data-act="del">' + t('del') + '</button>' : '') +
      '<button class="kb-btn-ghost" data-act="cancel">' +
      t('close') +
      '</button>' +
      (canEdit ? '<button class="kb-btn-save" data-act="save">' + t('save') + '</button>' : '') +
      '</div>';
    this.positionPop(this.notePop, anchorEl.getBoundingClientRect());
    (this.notePop.querySelector('[data-act="cancel"]') as HTMLElement).onclick = () =>
      this.closeNotePop();

    if (canEdit) {
      const ta = this.notePop.querySelector('textarea')!;

      ta.focus();
      (this.notePop.querySelector('[data-act="save"]') as HTMLElement).onclick = () =>
        notesStore.saveEditNote(note, ta.value);
      (this.notePop.querySelector('[data-act="del"]') as HTMLElement).onclick = () =>
        notesStore.deleteNote(note);
    }
  }

  // Text selection → floating "Note" button (edit mode only). We store the anchor + rect at
  // selection time, so the button tap doesn't need the selection to survive (on mobile the tap
  // collapses it).
  private updateNoteButton(): void {
    // Notes anchor into a markdown doc: no meaning on the home page (no currentFile) nor a
    // .html/.pdf (isolated iframe).
    if (
      !this.notesCanEdit() ||
      editMode ||
      this.notePop.style.display === 'block' ||
      !currentFile ||
      currentFile.ext !== '.md'
    ) {
      this.noteAddBtn.style.display = 'none';

      return;
    }

    const a = noteAnchor.selectionToAnchor();

    if (!a) {
      this.noteAddBtn.style.display = 'none';

      return;
    }

    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();

    this.pendingButtonAnchor = a;
    this.pendingButtonRect = rect;
    this.noteAddBtn.style.display = 'inline-flex';
    // Placed BELOW the selection: the native copy/paste bar (mobile) is above it.
    const bw = this.noteAddBtn.offsetWidth || 96;
    let left = window.scrollX + rect.left;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - bw - 8;

    if (left > maxLeft) left = maxLeft;
    this.noteAddBtn.style.top = window.scrollY + rect.bottom + 8 + 'px';
    this.noteAddBtn.style.left = Math.max(8, left) + 'px';
  }

  private triggerNoteCreate(): void {
    if (!this.pendingButtonAnchor) return;
    this.noteAddBtn.style.display = 'none';
    this.openNotePopForNew(this.pendingButtonAnchor, this.pendingButtonRect!);
  }

  private maybeCloseOutside(e: Event): void {
    const target = e.target as Element;

    if (
      !this.notePop.contains(target) &&
      target !== this.noteAddBtn &&
      !this.noteAddBtn.contains(target) &&
      !target.closest('mark.kb-annot') &&
      !target.closest('.kb-note-row')
    ) {
      if (this.notePop.style.display === 'block') this.closeNotePop();

      if (!target.closest('#content')) this.noteAddBtn.style.display = 'none';
    }
  }
}

export const notePopover = new NotePopover();
