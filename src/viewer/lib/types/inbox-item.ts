// One GET /api/inbox item — the wire DTO (src/server/pure/queries.py). captured_at is unix
// seconds from the git commit date / mtime, not the frontmatter key.
interface InboxItem {
  path: string;
  title: string;
  preview: string;
  source: string;
  confidence: number;
  suggest_dest: string;
  suggest_tags: string[];
  neighbors: string[];
  status: string;
  captured_at: number;
}
