// One [[wikilink]] autocomplete candidate, built from a fileMap entry. _name / _hay are the
// pre-lowercased match keys (stem alone, and "stem path") so filtering/ranking skips re-casing.
interface WlCandidate {
  path: string;
  label: string;
  sub: string;
  mtime: number;
  _name: string;
  _hay: string;
}
