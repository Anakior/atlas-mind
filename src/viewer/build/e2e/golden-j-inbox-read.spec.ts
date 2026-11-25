import { test, expect } from '@playwright/test';

// GOLDEN J — an inbox item reads in full before it is triaged.
//
// The focus card renders the item's own file (headings, lists, links), folded to its first lines.
// "Read it all" in the home's narrow card opens the Inbox panel on that item, unfolded; O folds it
// back. A link in the item opens in a new tab, so the triage is never left. A short item offers
// nothing to unfold.

// The service worker fetches .md files itself, out of page.route's reach.
test.use({ serviceWorkers: 'block' });

const activity = {
  events: [{
    author: 'Dev Local', email: 'dev@local', date: new Date().toISOString(),
    type: 'edit', title: 'Welcome', paths: ['welcome.md'], short_sha: 'abc1234',
    subject: 'edited welcome', ai: null,
  }],
};

const OFFER = `---
origin: inbox
source: gmail
---

# Lead dev at Klayn

**Klayn** · Lyon · full time

## Missions

${Array.from({ length: 12 }, (_, i) => `- Mission number ${i + 1}`).join('\n')}

[Full offer](https://jobs.example.com/klayn)
`;

function inboxItem(path: string, title: string, confidence: number) {
  return {
    path, title, source: 'gmail', confidence, suggest_dest: 'Projects/',
    preview: 'A flat preview.', captured_at: Math.floor(Date.now() / 1000) - 120,
  };
}

test('J — an inbox item unfolds in the panel, folds back with O, keeps its links beside', async ({ page }) => {
  await page.route('**/api/activity*', (route) => route.fulfill({ json: activity }));
  const inbox = [inboxItem('inbox/offer.md', 'Lead dev at Klayn', 0.9), inboxItem('inbox/short.md', 'Short note', 0.5)];
  await page.route('**/api/inbox*', (route) => route.fulfill({ json: { inbox } }));
  await page.route('**/inbox/offer.md*', (route) => route.fulfill({ body: OFFER, contentType: 'text/markdown' }));
  await page.route('**/inbox/short.md*', (route) => route.fulfill({ body: '# Short note\n\nOne line.', contentType: 'text/markdown' }));
  await page.context().route('https://jobs.example.com/**', (route) => route.fulfill({ body: 'offer' }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The home's card: the item rendered (not the flat preview), its title not repeated, folded.
  const home = page.locator('#home-card-inbox');
  await expect(home.locator('.ibx-doc h2')).toHaveText('Missions');
  await expect(home.locator('.ibx-doc h1')).toHaveCount(0);
  await expect(home.locator('.ibx-doc')).toHaveClass(/folded/);

  // Read it all: the panel opens on the same item, unfolded.
  await home.locator('.ibx-more').click();
  const doc = page.locator('#side-panel-body .ibx-doc');
  await expect(page.locator('#side-panel')).toBeVisible();
  await expect(page.locator('#side-panel-body .ibx-title')).toHaveText('Lead dev at Klayn');
  await expect(doc).not.toHaveClass(/folded/);

  // A link opens in a new tab; the panel stays.
  const [popup] = await Promise.all([page.waitForEvent('popup'), doc.getByRole('link', { name: 'Full offer' }).click()]);
  await expect(popup).toHaveURL('https://jobs.example.com/klayn');
  await popup.close();
  await expect(page.locator('#side-panel')).toBeVisible();

  // O folds it back.
  await page.keyboard.press('o');
  await expect(doc).toHaveClass(/folded/);

  // A one-line item has nothing to unfold.
  await page.keyboard.press('j');
  await expect(page.locator('#side-panel-body .ibx-title')).toHaveText('Short note');
  await expect(page.locator('#side-panel-body .ibx-doc')).toContainText('One line.');
  await expect(page.locator('#side-panel-body .ibx-more')).toHaveCount(0);
});
