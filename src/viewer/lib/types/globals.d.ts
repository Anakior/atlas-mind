// Ambient declarations for the symbols that live outside the typed module graph: the build barewords
// render.py substitutes, the Atlas DOM runtime the IIFE assigns onto the shared scope, the QR codec
// 17-qr.ts exposes, and the window.* augmentations. Everything else is a real .ts symbol in the
// shared (transform-concat) scope and needs no declaration here.

// Raw build-substitution barewords: render.py pastes a JSON literal over each in one regex pass.
// 00-data-csrf.ts reads them (const TREE = __DATA__). `declare` is type-only, erased by esbuild, so
// the bareword survives into the bundle for the Python build to fill.
declare const __DATA__: DirNode;
declare const __EMBED_CONTENT__: Record<string, string> | null;
declare const __EMBED_BACKLINKS__: any;
declare const __EMBED_NOTES__: any;
declare const __EMBED_TASKS__: any;
declare const __EMBED_ACTIVITY__: any;
declare const __TEMPLATES__: Record<string, string>;
declare const __TAGLINE_JSON__: string;
declare const __SITE_PREFIX_JSON__: string;
declare const __TODO_CATEGORIES_JSON__: Array<{ cat: string; label: string }>;

// Atlas DOM runtime (00b-atlas-dom.ts): the keyed virtual-DOM the IIFE assigns onto the shared scope
// (assigned, not a top-level declaration), so tsc needs the ambient. Reconciler internals stay
// private to the IIFE.
declare const h: {
  (tag: string, props?: Record<string, any> | null, ...children: Child[]): VNode;
  host(tag: string, props?: Record<string, any> | null): VNode;
};
declare function raw(html: string): VNode;
declare function render(next: Child, container: Element): void;
declare function createApp(
  container: Element,
  view: (state?: any) => Child,
): { render(state?: any): void; unmount(): void };
declare function Show(cond: any, view: () => Child): Child;

interface Window {
  AtlasInbox: {
    mount(container: Element): void;
    show(): void;
    hide(): void;
    refreshBadge(): Promise<void>;
  };
  AtlasUI: {
    btnPrimary: string;
    btnDanger: string;
    btnSecondary: string;
    input: string;
    label: string;
  };
  Atlas: AtlasExtensionAPI;
  refreshActivityData?: () => void;
  mountActivity?: () => void;
  openAccessFor?: (path: string) => void;
  softReload?: () => Promise<void>;
  __viewerMode?: boolean;
  mammoth?: { convertToHtml(o: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
}
