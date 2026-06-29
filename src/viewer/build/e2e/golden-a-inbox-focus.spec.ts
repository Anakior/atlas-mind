import { test, expect } from '@playwright/test';

// GOLDEN A — focus + uncommitted value survive the inbox 5s poll.
//
// Invariant (the oracle for the TS/runtime migration): while a destination editor is
// open in the inbox focus card, the live poll appends new queue rows BELOW the focus
// card and must not touch the focused input — focus, caret and the uncommitted value
// stay put. The current code earns this with the editing() guard (inbox.ts refreshSub/poll):
// the append is unconditional but the chip/toast refresh is skipped while an input is open.
// The runtime rewrite must keep this true by construction.
//
// We mock the two reads the inbox tab needs: /api/activity (so the home Activity card
// mounts at all) and /api/inbox (mutable — the poll re-fetches it, and we stage a new
// item from a NEW source mid-edit). The dev sandbox has an empty activity feed, hence
// the activity mock.

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

test('A — inbox focus + uncommitted value survive the 5s poll', async ({ page }) => {
  await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));
  let inbox = [inboxItem('inbox/a.md', 'gmail', 'First captured item')];
  await page.route('**/api/inbox*', (route) => route.fulfill({ json: { inbox } }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#home-activity-card [data-view="inbox"]').click();
  const focus = page.locator('#ibx-focus');
  await focus.waitFor();

  // Open the destination editor and replace its value with an UNCOMMITTED one.
  // No Enter, no blur — a blur would commit after 180ms (22-inbox.js:393) and destroy
  // the very state under test.
  await focus.locator('.ibx-destchip').click();
  const editor = page.locator('input.ibx-destedit');
  await expect(editor).toBeFocused();
  await editor.fill('Inbox/Triage/Mine');
  const editorHandle = await editor.elementHandle();

  // Baseline above the input: a single source (gmail) shows no filter chip — a lone source chip is
  // just the MCP's own name and filters nothing, so the bar is empty here. No toast either.
  await expect(page.locator('#ibx-chips-wrap .ibx-chip')).toHaveCount(0);
  await expect(page.locator('#ibx-toast')).toHaveCount(0);

  // A second item from a NEW source arrives; the next poll (≤5s) must append exactly
  // one queue row below the focus card.
  inbox = [inbox[0], inboxItem('inbox/b.md', 'sentry', 'Second captured item')];
  await expect(page.locator('#ibx-next-rows .ibx-qrow')).toHaveCount(1, { timeout: 8_000 });

  // The invariant: the focused editor and its uncommitted value are untouched.
  await expect(editor).toBeFocused();
  expect(await editorHandle!.evaluate((el) => el === document.activeElement)).toBe(true);
  await expect(editor).toHaveValue('Inbox/Triage/Mine');

  // The editing() guard froze the region ABOVE the input: the new 'sentry' source did NOT refresh
  // the chips (a second source would otherwise surface the filter bar), and no "new items" toast was
  // shown — both would have shifted the input and detached the combobox popup. The bar stays empty.
  await expect(page.locator('#ibx-chips-wrap .ibx-chip')).toHaveCount(0);
  await expect(page.locator('#ibx-toast')).toHaveCount(0);
});
