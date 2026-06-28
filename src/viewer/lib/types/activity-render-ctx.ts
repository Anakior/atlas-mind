// The render context the ActivityCard shell hands to each of its view classes (Journal / Orrery /
// Health). It exposes the shared live state (the filtered feed + the journal toggles) and the shell's
// helper cluster WITHOUT copying any of it: every view renders from the one source of truth, so the
// helpers can never diverge between views (divergent helpers = divergent output). The shell builds
// this object once; the views only ever read through it.
interface ActivityRenderCtx {
  // The feed honoring the AI-only filter — the source Journal and the Orrery both index into.
  shownItems(): ActivityItem[];
  // Live journal-view state: the shell mutates these, the views read them at render time.
  readonly expanded: boolean;
  readonly aiOnly: boolean;
  // Helper cluster (single implementation, owned by the shell).
  TY(type: string): { label: string; color: string; d: string };
  iconSvg(type: string, size: number): string;
  verb(type: string): string;
  verbPhrase(type: string): string;
  avatar(e: ActivityItem, size: number): string;
  aiBadge(family: string): string;
  rel(min: number): string;
  dayKey(min: number): string;
  docTitle(p: string): string;
  skelRows(n: number): string;
  openDocHistory(path: string): void;
}
