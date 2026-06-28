// Notes persistence (CRUD) for the current doc: load the sidecar list, create / edit / delete an
// annotation, then refresh the tree badge + re-render the doc. Data lives in .notes/<doc>.json
// server-side (offline: EMBED_NOTES). The write methods close the popover (notePopover) on success
// and re-render via showMarkdown; the loaded list is shared through noteContext (filled by
// NotesPanel, read here by the copy-all export).
class NotesStore {
  async fetchNotes(file: FileNode): Promise<NotePersisted[]> {
    if (IS_OFFLINE_BUILD) return (EMBED_NOTES && EMBED_NOTES[file.path]) || [];

    try {
      const res = await fetch('/api/notes?path=' + encodeURIComponent(file.path), {
        cache: 'no-cache',
      });

      return res.ok ? await res.json() : [];
    } catch (e) {
      return [];
    }
  }

  // Copies all notes of the current doc as markdown (quote + note) for sharing.
  async copyAllNotes(btn: Element | null): Promise<void> {
    if (!noteContext.notesForDoc.length) return;
    const lines: string[] = [];
    const title = currentFile ? currentFile.name || currentFile.path : '';

    if (title) lines.push('# Notes — ' + title, '');
    noteContext.notesForDoc.forEach((n) => {
      if (n.exact && !n._orphan) lines.push('> ' + n.exact);
      lines.push(n.note);
      const meta: string[] = [];
      if (n.author) meta.push(String(n.author));
      if (n.created) meta.push(new Date(n.created * 1000).toLocaleString(LANG));
      if (meta.length) lines.push('— ' + meta.join(' · '));
      lines.push('');
    });
    await copyToClipboard(lines.join('\n').trim() + '\n');

    if (btn) {
      btn.classList.add('text-emerald-400');
      setTimeout(() => btn.classList.remove('text-emerald-400'), 1200);
    }

    setStatus(t('notesCopied', noteContext.notesForDoc.length), 'ok');
  }

  async saveNewNote(anchor: TextQuoteAnchor | null, text: string): Promise<void> {
    text = (text || '').trim();

    if (!text || !anchor || !currentFile) return;
    const body = Object.assign({ path: currentFile.path, note: text }, anchor);

    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      notifyError('noteSaveFailed', (e as Error).message);

      return;
    }

    notePopover.closeNotePop();
    window.getSelection()!.removeAllRanges();
    this.refreshNotes();
  }

  async saveEditNote(note: NoteResolved, text: string): Promise<void> {
    text = (text || '').trim();

    if (!text || !currentFile) return;

    try {
      const res = await fetch(
        '/api/notes?path=' +
          encodeURIComponent(currentFile.path) +
          '&id=' +
          encodeURIComponent(note.id),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: text }),
        },
      );

      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      notifyError('actionFailed', (e as Error).message);

      return;
    }

    notePopover.closeNotePop();
    this.refreshNotes();
  }

  async deleteNote(note: NoteResolved): Promise<void> {
    if (!currentFile) return;
    const ok = await confirmDialog({
      title: t('deleteNoteTitle'),
      message: t('deleteNoteMsg', note.note.length > 80 ? note.note.slice(0, 80) + '…' : note.note),
      confirmLabel: t('del'),
      destructive: true,
    });

    if (!ok) return;

    try {
      const res = await fetch(
        '/api/notes?path=' +
          encodeURIComponent(currentFile.path) +
          '&id=' +
          encodeURIComponent(note.id),
        { method: 'DELETE' },
      );

      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      notifyError('actionFailed', (e as Error).message);

      return;
    }

    notePopover.closeNotePop();
    this.refreshNotes();
  }

  // Full re-render of the current doc + live tree-badge update. We recount notes from the SOURCE
  // (/api/notes) because _notes-index.json is only regenerated at the next build — without this the
  // badge only appeared after a reload.
  private async refreshNotes(): Promise<void> {
    if (!currentFile) return;
    const path = currentFile.path;

    try {
      const res = await fetch('/api/notes?path=' + encodeURIComponent(path), { cache: 'no-cache' });
      const list = res.ok ? await res.json() : null;

      if (Array.isArray(list)) {
        const idx = await loadNotesIndex();

        if (list.length) idx[path] = list.length;
        else delete idx[path];
        decorateTreeBadges();
      }
    } catch (_) {}

    showMarkdown(currentFile);
  }
}

const notesStore = new NotesStore();
