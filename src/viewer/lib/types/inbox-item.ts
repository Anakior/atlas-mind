// One GET /api/inbox item — the wire DTO (src/server/pure/queries.py). captured_at is unix
// seconds from the git commit date / mtime, not the frontmatter key.
interface InboxItem {
  path: string;
  title: string;
  preview: string;
  source: string;
  // The KIND of item (note/task/idea/question/reference/alert…), set by the agent at capture or
  // defaulted to "note". Free vocabulary; drives the type badge + the type filter chips.
  type: string;
  confidence: number;
  suggest_dest: string;
  suggest_tags: string[];
  neighbors: string[];
  status: string;
  captured_at: number;
}
