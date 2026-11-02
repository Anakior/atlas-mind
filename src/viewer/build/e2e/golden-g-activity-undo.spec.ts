import { test, expect } from '@playwright/test';

// GOLDEN G — "Undo this run" from the home Activity journal.
//
// A row's undo button opens, under the row, the run that change belongs to: each doc with what
// undoing does to it, a doc the viewer could not change by hand ticked off and locked. Unticking a
// doc keeps it: the undo then names only the ticked docs. The reads and the undo are mocked (the dev
// sandbox keeps no git history); test_mcp_sessions.TestUndoFromActivity covers the server side.

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
const activity = {
  events: [
    { author: 'Dev Local', email: 'dev@local', date: iso(5), type: 'create', title: 'Pricing notes',
      paths: ['notes/pricing.md'], short_sha: 'aaa1111', subject: 'created: pricing', ai: 'claude' },
    { author: 'Dev Local', email: 'dev@local', date: iso(12), type: 'edit', title: 'Welcome',
      paths: ['welcome.md'], short_sha: 'bbb2222', subject: 'edited: welcome', ai: 'claude' },
  ],
};
const run = {
  id: 'bbb2222bbb22-aaa1111aaa11', ai: 'claude', author: 'Dev Local', start: iso(12), end: iso(5), commits: 3,
  documents: [
    { path: 'notes/pricing.md', change: 'added', may_undo: true },
    { path: 'welcome.md', change: 'modified', may_undo: true },
    { path: 'private/plan.md', change: 'modified', may_undo: false },
  ],
};

test('G — a run opened from the journal is undone for the docs left ticked', async ({ page }) => {
  await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));
  await page.route('**/api/run?*', (route) => route.fulfill({ json: run }));
  let undone: unknown = null;
  await page.route('**/api/run/undo', (route) => {
    undone = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, message: 'Undid' } });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator('#activity-journal .act-row').first();
  await row.hover();
  await row.locator('.act-undo').click();

  const panel = page.locator('.act-undo-panel');
  await expect(panel.locator('.act-undo-doc')).toHaveCount(3);
  await expect(panel.locator('.act-undo-doc.is-locked input')).toBeDisabled();
  const go = panel.locator('.act-undo-go');
  await expect(go).toHaveText('Undo these 2 changes');

  await panel.locator('.act-undo-doc').nth(1).click();  // unticks welcome.md
  await expect(go).toHaveText('Undo this change');
  await go.click();
  await expect.poll(() => undone).toEqual({ run: run.id, paths: ['notes/pricing.md'] });

  // The same button closes the panel.
  await row.locator('.act-undo').click();
  await row.locator('.act-undo').click();
  await expect(page.locator('.act-undo-panel')).toHaveCount(0);
});

test('G — a journal row opens its doc from the title, its history from the rest', async ({ page }) => {
  await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // notes/pricing.md is not in the dev mind: a doc gone from the mind has only its history left.
  const gone = page.locator('#activity-journal .act-row').first();
  await expect(gone).toContainText('Pricing notes');
  await expect(gone.locator('.act-open')).toHaveCount(0);

  const row = page.locator('#activity-journal .act-row').nth(1);
  await row.hover();
  await expect(row.locator('.act-open-btn')).toBeVisible();
  await row.locator('.act-title').click();
  await expect(page).toHaveURL(/#welcome\.md$/);
  await expect(page.locator('#content h1').first()).toHaveText('Welcome to Atlas Mind');
});
