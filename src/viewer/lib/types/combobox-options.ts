// Option bag for AtlasCombobox (ui/combobox.ts). source is the only required field — the current
// suggestion list, sync or async; the rest tune the creatable / multi / formatting behaviour.
interface ComboboxOptions {
  source: () => string[] | Promise<string[]>;
  creatable?: boolean; // offer « Créer "X" » when the typed value has no match
  multi?: boolean; // chips mode (tags, group members); getValue() yields the array at runtime
  separator?: string; // CSV split/join for setValue in multi mode (default ',')
  normalize?: (value: string) => string; // canonicalize a pick before commit (e.g. lowercase emails)
  format?: (value: string) => string; // row HTML (default escapeHtml)
  maxItems?: number; // display cap (default 50)
  onSelect?: (value: string) => void; // pick callback; else the value is written to the input
}
