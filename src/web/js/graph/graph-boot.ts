// Connections-graph bootstrap — built LAST in the 12-* family (12z sorts after the pieces and the
// controller), same pattern as 21z-activity-boot.ts. Concat = load order and `class` does not hoist:
// 12-graph-palette/layout/renderer define the pieces, 12-graph defines the controller, and only here
// does the load-time `new MindGraph()` run its field initializers — so every class is in scope.
//
// mindGraph stays a global (11-palette-pins dispatches to it by name); openGraph is the bareword the
// home view wires to #home-graph-btn. Both delegate to the single instance.
const mindGraph = new MindGraph();

// Thin wrapper for 10-home-layout's home view (it wires #home-graph-btn → openGraph).
function openGraph(): void {
  mindGraph.open();
}

// Embed hero: open the graph chrome-less. The host iframe is pointer-events:none, so there is nothing
// to interact with — it just lives.
if (EMBED_MIND) {
  const gc = document.getElementById('graph-controls');

  if (gc) gc.style.display = 'none';
  mindGraph.open();
}
