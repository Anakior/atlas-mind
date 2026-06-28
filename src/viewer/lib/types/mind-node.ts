// A node of the connections graph: a document (kind:'doc') or a tag hub (kind:'tag'). Both share the
// physics/render fields (x/y/vx/vy/deg/r, color); the kind-specific fields are optional and read only
// under a kind guard. NB: distinct from interface/GraphNode (the avatar constellation node).
interface MindNode {
  kind: 'doc' | 'tag';
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  deg: number;
  r: number; // radius, computed from degree after the build (seeded 0)
  // doc-only
  path?: string;
  doctype?: string;
  tags?: string[];
  region?: string; // top-level folder (family)
  subRegion?: string; // immediate subfolder
  subKey?: string; // region/subRegion, the sub-anchor key
  remote?: boolean;
  mtime?: number;
  recent?: boolean;
  // tag-only
  tag?: string;
  docs?: number;
  // scratch: structured layout local offset, hover adjacency, breath phase
  _lx?: number;
  _ly?: number;
  _adj?: boolean;
  _ph?: number;
}
