// window.Atlas — the public, versioned extension API (defined in modals/new-file-modal.ts, consumed by
// examples/extensions/*). Extensions register new-document templates and drive the viewer through
// it; the viewer also dispatches atlas:doc-rendered {path, markdown} and atlas:edit-enter on
// document, and freezes the soft-reload while a [data-atlas-modal] is visible. Stable contract:
// type additively, never break a field.
interface AtlasExtensionAPI {
  version: 1;
  t(key: string, ...args: unknown[]): string;
  escapeHtml(s: unknown): string;
  setStatus(msg: string, kind?: StatusKind): void;
  refresh(): Promise<void>; // re-render the tree (soft-reload) or fall back to a full reload
  currentDoc(): { path: string } | null; // the markdown doc currently displayed, or null
  invalidateDoc(path: string): void; // drop a doc's cache after a write made outside the viewer
  registerTemplate(value: string, provider: TemplateProvider): boolean;
}
