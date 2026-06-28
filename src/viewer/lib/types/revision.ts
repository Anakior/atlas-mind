// One git revision of a doc, from GET /api/history (newest-first). `ai` is the agent/model label
// when the commit was AI-authored; the optional fields can be absent on bare-message commits.
interface Revision {
  sha: string;
  subject?: string;
  date?: string;
  author?: string;
  ai?: string;
}
