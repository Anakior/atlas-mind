// The handle AtlasCombobox returns. getValue is the trimmed input in single mode; in multi (chips)
// mode it returns the selected array at runtime, typed string here so single-mode callers read it
// directly (the one multi caller only re-serializes it).
interface ComboboxController {
  getValue(): string;
  setValue(value: string): void;
  refresh(): void;
  clear(): void;
  focus(): void;
  open(): void;
  close(): void;
  destroy(): void;
}
