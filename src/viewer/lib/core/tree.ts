// Tree indexing: fileMap (path → file node) + index() that walks the tree. statsEl, t, the
// counters (mdCount/otherCount) and TREE/IS_OFFLINE_BUILD come from the core imports below.
import { IS_OFFLINE_BUILD, TREE } from './data-csrf';
import { statsEl } from './dom-refs';
import { t } from './i18n';
import { mdCount, otherCount, setMdCount, setOtherCount } from './state';

export const fileMap: Record<string, FileNode> = {};

export function index(node: TreeNode): void {
  const children = node.type === 'dir' ? node.children : [];

  for (const c of children) {
    if (c.type === 'file') {
      fileMap[c.path] = c;

      if (c.ext === '.md') setMdCount(mdCount + 1);
      else setOtherCount(otherCount + 1);
    } else index(c);
  }
}

// Offline build only: index the baked FULL tree into fileMap. In SERVER mode that
// baked tree is the owner's complete build-time view, so indexing it here would
// leak private doc names + the total count through every fileMap consumer (Recent,
// search, the Mind, stats) BEFORE softReload() swaps in the per-account filtered
// /api/tree. Gated on IS_OFFLINE_BUILD, NOT the protocol: a static offline build is
// served over https on GitHub Pages, so a file:// check would wrongly skip it.
if (IS_OFFLINE_BUILD) {
  index(TREE);
}
statsEl.textContent = t('statsLine', mdCount, otherCount);
