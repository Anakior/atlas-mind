import { test, expect } from '@playwright/test';

// GOLDEN B — expanded sidebar folders survive an SSE soft-reload, keyed on the FULL
// dir path (not the basename).
//
// Invariant: softReload() snapshots which folders are open by their data-dir-path and
// re-applies it after rebuilding the tree (src/web/js/99-bootstrap.js:106-124). The key
// is the FULL path, so two folders sharing a basename under different parents keep
// INDEPENDENT open state — the documented homonym bug. The runtime rewrite (openDirs as
// a Set<string> rendered from state) must preserve this.
//
// /api/tree returns the root node {name,type,children}; softReload re-fetches it, so we
// mock it with nested homonym folders. Node fields mirror the real shape so the
// post-render decorate passes don't throw (a throw is swallowed and would silently
// leave the tree unpatched).

function file(path: string) {
  return { name: path.split('/').pop(), type: 'file', path, ext: '.md', mtime: 1781890000, words: 10, tags: [] };
}
const tree = {
  name: 'root',
  type: 'dir',
  children: [
    { name: 'alpha', type: 'dir', children: [
      { name: 'notes', type: 'dir', children: [file('alpha/notes/x.md')] },
    ] },
    { name: 'beta', type: 'dir', children: [
      { name: 'notes', type: 'dir', children: [file('beta/notes/y.md')] },
    ] },
  ],
};

const caret = (dirPath: string) => `#tree button[data-dir-path="${dirPath}"] .caret`;

test('B — expanded folders preserved on SSE reload, homonyms stay independent', async ({ page }) => {
  await page.route('**/api/tree', (route) => route.fulfill({ json: tree }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tree');
  // Load the homonym tree into the viewer (the embedded boot tree is the real dev one).
  await page.evaluate(() => window.softReload());

  // Top-level folders auto-expand (depth 0); the nested 'notes' folders start collapsed.
  await expect(page.locator(caret('alpha/notes'))).not.toHaveClass(/open/);
  await expect(page.locator(caret('beta/notes'))).not.toHaveClass(/open/);

  // Expand exactly ONE of the two homonym 'notes' folders.
  await page.locator('#tree button[data-dir-path="alpha/notes"]').click();
  await expect(page.locator(caret('alpha/notes'))).toHaveClass(/open/);

  // SSE soft-reload (same tree).
  await page.evaluate(() => window.softReload());

  // Invariant: the expanded nested folder stays open, its homonym stays closed, and the
  // auto-expanded top-level folders stay open.
  await expect(page.locator(caret('alpha/notes'))).toHaveClass(/open/);
  await expect(page.locator(caret('beta/notes'))).not.toHaveClass(/open/);
  await expect(page.locator(caret('alpha'))).toHaveClass(/open/);
  await expect(page.locator(caret('beta'))).toHaveClass(/open/);
});
