// The activity layer's read-side payload: GET /api/activity online, or the frozen EMBED_ACTIVITY
// embed offline (public minds). StaleDoc rows come from /api/stale, ContradictionCand from
// /api/contradictions — both surfaced in the card's "Santé" view.
interface StaleDoc {
  path: string;
  months_ago: number;
}

interface ContradictionCand {
  a: string;
  b: string;
  kind?: string;
  a_value?: string;
  b_value?: string;
  subject?: string;
  confidence?: string;
  verdict?: string;
  a_line?: number;
  b_line?: number;
  evidence?: { text: string }[];
}

interface ActivitySnapshot {
  events: ActivityRaw[];
  stale: StaleDoc[];
  contradictions: ContradictionCand[];
}
