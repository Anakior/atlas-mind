// One GET /api/search result (the wire shape; the client reads path + snippet).
interface SearchHit {
  path: string;
  name: string;
  score: number;
  snippet: string;
  mtime: number;
}
