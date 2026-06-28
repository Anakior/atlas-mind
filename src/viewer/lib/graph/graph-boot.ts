// Connections-graph bootstrap — constructs the single MindGraph instance (same split as the activity
// card's admin/activity/activity-boot.ts: the class lives in mind-graph.ts, the instance is created
// here). ESM import resolution guarantees MindGraph and its injected pieces
// (graph-palette/graph-layout/graph-renderer) are defined before `new MindGraph()` runs.
//
// mindGraph is exported and imported wherever the graph is opened — command-palette.ts and
// keyboard-router.ts dispatch to it, and home-view.ts wires #home-graph-btn to mindGraph.open(); all
// share this one instance.

import { EMBED_MIND } from '../core/state';
import { MindGraph } from './mind-graph';

export const mindGraph = new MindGraph();

// Embed hero: open the graph chrome-less. The host iframe is pointer-events:none, so there is nothing
// to interact with — it just lives.
if (EMBED_MIND) {
  const gc = document.getElementById('graph-controls');

  if (gc) gc.style.display = 'none';
  mindGraph.open();
}
