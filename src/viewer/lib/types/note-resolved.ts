// A NotePersisted after its anchor is re-located against the rendered markdown: `_orphan` is
// true when the quoted passage no longer exists, so no <mark> could be placed.
interface NoteResolved extends NotePersisted {
  _orphan: boolean;
}
