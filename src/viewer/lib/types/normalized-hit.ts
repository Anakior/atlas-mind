// getSearchHits normalizes both engines (online /api/search, offline MiniSearch) to this shape.
interface NormalizedHit {
  path: string;
  snippet: string;
}
