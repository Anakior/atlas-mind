// A folder in the viewer tree.
interface DirNode {
  name: string;
  type: 'dir';
  children: TreeNode[];
}
