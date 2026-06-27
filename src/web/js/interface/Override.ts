// A persisted per-item inbox edit, re-applied onto fresh items across reloads (keyed by path).
interface Override {
  dest?: string;
  tags?: string[];
}
