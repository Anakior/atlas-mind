// The whole live state of the connections graph, owned by MindGraph while the overlay is open.
// allNodes/allEdges is the full set; nodes/edges is the view for the current mode (tags filtered out
// of organic by default). Anchors seed the force layout per folder; clusters/families are the
// structured-map scaffold. cam is the pan/zoom transform.
interface MindGraphState {
  allNodes: MindNode[];
  allEdges: MindEdge[];
  nodes: MindNode[];
  edges: MindEdge[];
  regionAnchors: Record<string, { x: number; y: number }>;
  subAnchors: Record<string, { x: number; y: number }>;
  ring: number;
  mode: 'organic' | 'structured';
  showTags: boolean;
  clusters: Array<{ x: number; y: number; r: number; sub: string; color: string }>;
  families: Array<{ x: number; y: number; r: number; name: string; color: string }>;
  cam: { scale: number; ox: number; oy: number };
  ticks: number;
  hover: MindNode | null;
  drag: MindNode | null;
  panFrom: { x: number; y: number; ox: number; oy: number } | null;
  moved: boolean;
}
