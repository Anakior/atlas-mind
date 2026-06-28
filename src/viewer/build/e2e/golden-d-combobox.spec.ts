import { test, expect, type Page } from '@playwright/test';

// GOLDEN D — the inbox destination combobox popup survives a live update AND stays
// correctly positioned under its input.
//
// The popup is a single div.atlas-cb-pop appended to <body>, position:fixed, placed
// ONCE from input.getBoundingClientRect() (13-combobox.js:97-100). It has no scroll/
// resize re-position listener, so "still positioned" holds iff the input never moves.
//
// Two triggers, two protections — both must hold, and the migration must keep them:
//  - poll: the editing() guard skips everything above the input (22-inbox.js:313-317).
//  - softReload: refreshActivityData early-returns while the inbox tab is active
//    (21-activity.js:662-663), so the inbox DOM (and the body-level popup) is untouched.
//    NOTE: this protection is NOT in shouldAbortReload — softReload still runs and still
//    rebuilds the sidebar tree; the inbox survives only because of that early-return.

const activity = {
  events: [{
    author: 'Dev Local', email: 'dev@local', date: new Date().toISOString(),
    type: 'edit', title: 'Welcome', paths: ['welcome.md'], short_sha: 'abc1234',
    subject: 'edited welcome', ai: null,
  }],
};
function inboxItem(path: string, source: string, title: string) {
  return {
    path, title, source, confidence: 0.9, suggest_dest: 'Projects/',
    preview: 'A short captured preview.', captured_at: Math.floor(Date.now() / 1000) - 120,
  };
}
const minimalTree = {
  name: 'root', type: 'dir',
  children: [{ name: 'docs', type: 'dir', children: [
    { name: 'a.md', type: 'file', path: 'docs/a.md', ext: '.md', mtime: 1781890000, words: 10, tags: [] },
  ] }],
};

const OPEN_POPUP = '.atlas-cb-pop:not(.hidden)';

// Open the inbox, open the destination editor, and confirm its combobox popup is shown.
// Returns a setter to mutate the mocked inbox (for the poll trigger).
async function openInboxEditor(page: Page) {
  await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));
  await page.route('**/api/tree', (route) => route.fulfill({ json: minimalTree }));
  let inbox = [inboxItem('inbox/a.md', 'gmail', 'First captured item')];
  await page.route('**/api/inbox*', (route) => route.fulfill({ json: { inbox } }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#home-activity-card [data-view="inbox"]').click();
  await page.locator('#ibx-focus').waitFor();
  await page.locator('#ibx-focus .ibx-destchip').click();
  await expect(page.locator('input.ibx-destedit')).toBeFocused();
  await expect(page.locator(OPEN_POPUP)).toBeVisible();

  return { setInbox: (items: ReturnType<typeof inboxItem>[]) => { inbox = items; } };
}

// Rounded rects of the editor input and the open popup, for an anchor check.
async function measure(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null) => {
      const b = el!.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), width: Math.round(b.width) };
    };
    return {
      input: r(document.querySelector('input.ibx-destedit')),
      pop: r(document.querySelector('.atlas-cb-pop:not(.hidden)')),
    };
  });
}

function expectAnchored(m: { input: { bottom: number; left: number; width: number }; pop: { top: number; left: number; width: number } }) {
  expect(Math.abs(m.pop.top - (m.input.bottom + 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(m.pop.left - m.input.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.pop.width - m.input.width)).toBeLessThanOrEqual(1);
}

test('D — combobox survives an SSE soft-reload, still anchored', async ({ page }) => {
  await openInboxEditor(page);
  const before = await measure(page);
  expectAnchored(before);

  await page.evaluate(() => window.softReload());

  await expect(page.locator(OPEN_POPUP)).toBeVisible();
  await expect(page.locator('input.ibx-destedit')).toBeFocused();
  const after = await measure(page);
  expect(after.input).toEqual(before.input);  // the input never moved
  expectAnchored(after);
});

test('D — combobox survives the 5s poll, still anchored', async ({ page }) => {
  const { setInbox } = await openInboxEditor(page);
  const before = await measure(page);
  expectAnchored(before);

  setInbox([inboxItem('inbox/a.md', 'gmail', 'First'), inboxItem('inbox/b.md', 'sentry', 'Second')]);
  await expect(page.locator('#ibx-next-rows .ibx-qrow')).toHaveCount(1, { timeout: 8_000 });

  await expect(page.locator(OPEN_POPUP)).toBeVisible();
  await expect(page.locator('input.ibx-destedit')).toBeFocused();
  const after = await measure(page);
  expect(after.input).toEqual(before.input);
  expectAnchored(after);
});
