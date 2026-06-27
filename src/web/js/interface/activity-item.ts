// The home Activity card's view model. ActivityRaw is the wire event from GET /api/activity (and
// the offline EMBED_ACTIVITY snapshot); toItem() projects it to ActivityItem, the shape every
// render method consumes. aggregate() collapses a run of same-doc/same-author/same-type events
// into one item carrying `count`. ActivityDigest is computeDigest()'s 7-day rollup.
interface ActivityRaw {
  type: string;
  date: string;
  author?: string;
  email?: string;
  title?: string;
  paths?: string[];
  short_sha?: string;
  sha?: string;
  subject?: string;
  ai?: string | null;
}

interface ActivityItem {
  who: string;
  first: string;
  last: string;
  email: string;
  ai: string | null;
  bot: boolean;
  type: string;
  title: string;
  agoMin: number;
  sha: string;
  path: string;
  subject: string;
  count?: number; // added by aggregate()
}

interface ActivityDigest {
  docs: number;
  created: number;
  checked: number;
  contributors: number;
  ai: number;
}
