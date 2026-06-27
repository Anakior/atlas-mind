// A node of the viewer tree — the shape of the TREE global and GET /api/tree.
// Discriminated on `type` (node.type === 'file').
type TreeNode = FileNode | DirNode;
