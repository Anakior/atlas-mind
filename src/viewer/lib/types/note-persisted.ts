// One annotation as persisted by the server (sidecar .notes/<doc>.json) and embedded offline
// (EMBED_NOTES): a text-quote anchor (exact passage + prefix/suffix context + approximate pos)
// plus the note body and authoring metadata. `updated`/`author` appear only after an edit / in
// cloud mode. Keys are pinned by tests/test_notes.py.
interface NotePersisted {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  pos: number;
  note: string;
  created: number;
  updated?: number;
  author?: string;
}
