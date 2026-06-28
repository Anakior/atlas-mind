// The viewer's single global boundary. Everything else in the bundle talks via ES-module imports;
// THIS is the deliberate window surface, gathered here so the contract reads at a glance:
//   - the public extension API (Atlas / AtlasUI / AtlasInbox), read by third-party extensions the
//     build inlines into the page;
//   - cross-boundary hooks called from outside the module graph (SSE/SW soft-reload, the inline
//     "manage access" button, the home activity card);
//   - flags the page sets before the bundle runs, and the .docx lib loaded on demand;
//   - the CSRF-injecting fetch wrapper (installed early in core/data-csrf).
// The runtime `window.X = …` assignments stay where each value is built; only the TYPES live here.
interface Window {
  Atlas: AtlasExtensionAPI;
  AtlasUI: { btnPrimary: string; btnDanger: string; btnSecondary: string; input: string; label: string };
  AtlasInbox: { mount(container: Element): void; show(): void; hide(): void; refreshBadge(): Promise<void> };
  softReload: () => Promise<void>;
  openAccessFor: (path: string) => void;
  mountActivity: () => void;
  refreshActivityData: () => void;
  __viewerMode?: boolean;
  mammoth?: { convertToHtml(o: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
  fetch: typeof fetch;
}
