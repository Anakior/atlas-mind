// A connections-graph edge: a wikilink ('link', drawn as a bowed arc with a firing pulse) or a tag
// membership ('tag', a faint straight line). _cx/_cy cache the arc's control point, set in the draw pass.
interface MindEdge {
  s: MindNode;
  t: MindNode;
  kind: 'link' | 'tag';
  _cx?: number;
  _cy?: number;
}
