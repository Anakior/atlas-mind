// A command-palette row: a static action (label/hint/icon/action) or a file hit. File rows carry
// the raw search query so the opened doc highlights the match, and an optional content snippet.
// Built in CommandPalette.renderResults, consumed by paint/select.
interface PaletteItem {
  kind: 'action' | 'file';
  label: string;
  hint?: string;
  icon?: string;
  action?: () => void; // kind:'action'
  file?: FileNode; // kind:'file'
  query?: string; // raw query, replayed as the highlight on open
  snippet?: string; // content-search excerpt
}
