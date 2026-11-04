// A folder in the viewer tree; `keep`: its .gitkeep, which keeps it even empty.
interface DirNode {
  name: string;
  type: 'dir';
  children: TreeNode[];
  keep?: string;
}
