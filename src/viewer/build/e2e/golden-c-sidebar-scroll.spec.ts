import { test, expect } from '@playwright/test';

// GOLDEN C — the sidebar tree scroll position survives an SSE soft-reload.
//
// WARNING for the migrator: this invariant is EMERGENT, not coded. Nothing saves or
// restores #tree.scrollTop anywhere (only `main`'s scroll is explicitly preserved,
// 99-bootstrap.js:143/146/160/162). The tree keeps its offset purely because softReload
// rebuilds it with `treeEl.innerHTML = ''; treeEl.appendChild(renderTree(TREE))` and
// nothing reads layout in between, so the browser never clamps scrollTop to 0. A rewrite
// that reads layout mid-swap, or rebuilds via a different node, can silently regress it.
// This test is the only thing that will catch that.

function file(path: string) {
  return { name: path.split('/').pop(), type: 'file', path, ext: '.md', mtime: 1781890000, words: 10, tags: [] };
}
// One auto-expanded top-level folder with enough files to overflow the sidebar.
const tree = {
  name: 'root',
  type: 'dir',
  children: [{
    name: 'docs',
    type: 'dir',
    children: Array.from({ length: 40 }, (_, i) => file(`docs/doc-${String(i).padStart(2, '0')}.md`)),
  }],
};

test('C — sidebar scrollTop preserved across SSE reload', async ({ page }) => {
  await page.route('**/api/tree', (route) => route.fulfill({ json: tree }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tree');
  await page.evaluate(() => window.softReload());

  // Scroll the tree and read back the (possibly clamped) actual offset.
  const before = await page.evaluate(() => {
    const t = document.getElementById('tree')!;
    t.scrollTop = 200;
    return { scrollTop: t.scrollTop, overflows: t.scrollHeight > t.clientHeight };
  });
  // The test is only meaningful if the tree actually scrolls.
  expect(before.overflows).toBe(true);
  expect(before.scrollTop).toBeGreaterThan(0);

  await page.evaluate(() => window.softReload());

  const after = await page.evaluate(() => document.getElementById('tree')!.scrollTop);
  expect(after).toBe(before.scrollTop);
});
