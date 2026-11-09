import { test, expect, type Page } from '@playwright/test';

// GOLDEN I — the huissier's dots: each quotation of a note gets a dot after its closing mark (found,
// altered; missing only in a note that quotes files), a click tells where and what the file says,
// and the file opens on the passage. The tree, the docs and /api/quotes are mocked, like golden H.

test.use({ serviceWorkers: 'block' });

const DOSSIER = '# Dossier\n\nIl a dit « le ratio est un point de **départ**, pas une définition » hier.\n\n'
  + 'Puis « chaque heure investie coûte trois fois son prix ».\n\nEt « une phrase que nul n’a écrite. »\n';
const SOURCE = '# Réunion\n\nIntro.\n\nLe ratio est un point de départ, pas une définition.\n';

function file(path: string) {
  return { name: path.split('/').pop(), type: 'file', path, ext: '.md', mtime: 1781890000, words: 10, tags: [] };
}

async function mind(page: Page, citesFiles: boolean) {
  const docs: Record<string, string> = { 'docs/dossier.md': DOSSIER, 'docs/reunion.md': SOURCE };

  await page.route('**/api/tree', (route) => route.fulfill({
    json: { name: 'root', type: 'dir', children: [{ name: 'docs', type: 'dir', children: Object.keys(docs).map(file) }] },
  }));
  for (const path of Object.keys(docs)) {
    await page.route(new RegExp('/' + path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '(\\?|$)'), (route) =>
      route.fulfill({ body: docs[path], contentType: 'text/markdown' }));
  }
  await page.route('**/api/quotes?*', (route) => route.fulfill({ json: {
    cites_files: citesFiles,
    quotes: new URL(route.request().url()).searchParams.get('path') !== 'docs/dossier.md' ? [] : [
      { line: 3, text: 'le ratio est un point de **départ**, pas une définition', state: 'found',
        source: { path: 'docs/reunion.md', line: 5, section: 'Réunion' } },
      { line: 5, text: 'chaque heure investie coûte trois fois son prix', state: 'altered',
        source: { path: 'docs/reunion.md', line: 7, says: '…chaque heure investie dans du neuf coûte trois fois son prix' } },
      { line: 7, text: 'une phrase que nul n’a écrite', state: 'missing' },
    ],
  } }));
}

async function open(page: Page, path: string) {
  await page.goto('/#' + encodeURIComponent(path), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#content h1');
}

test('I1 — a dot after each quotation, and what the file says', async ({ page }) => {
  await mind(page, true);
  await open(page, 'docs/dossier.md');

  const dots = page.locator('#content .kb-cite-dot');

  await expect(dots).toHaveCount(3);
  expect(await dots.evaluateAll((els) => els.map((e) => e.className))).toEqual([
    'kb-cite-dot kb-cite-found', 'kb-cite-dot kb-cite-altered', 'kb-cite-dot kb-cite-missing']);
  // Right after the closing mark, past the punctuation inside it; the text around it as it read.
  const before = await dots.evaluateAll((els) => els.map((d) => (d.previousSibling?.textContent || '').slice(-1)));

  expect(before).toEqual(['»', '»', '»']);
  await expect(page.locator('#content')).toContainText('pas une définition » hier.');

  await page.locator('#content .kb-cite-altered').click();
  await expect(page.locator('#kb-cite-pop blockquote')).toHaveText('…chaque heure investie dans du neuf coûte trois fois son prix');
  await page.keyboard.press('Escape');
  await expect(page.locator('#kb-cite-pop')).toHaveCount(0);
});

test('I2 — a quote found nowhere is marked only in a note that quotes files', async ({ page }) => {
  await mind(page, false);
  await open(page, 'docs/dossier.md');

  await expect(page.locator('#content .kb-cite-dot')).toHaveCount(2);
  await expect(page.locator('#content .kb-cite-missing')).toHaveCount(0);
});

test('I3 — the file opens on the passage', async ({ page }) => {
  await mind(page, true);
  await open(page, 'docs/dossier.md');
  await page.locator('#content .kb-cite-found').click();
  await page.locator('#kb-cite-pop .kb-cite-src').click();

  await expect(page.locator('#content h1')).toHaveText('Réunion');
  expect(page.url()).toContain('#' + encodeURIComponent('docs/reunion.md'));
  await expect.poll(() => page.evaluate(() => CSS.highlights.get('kb-cite')?.size ?? 0)).toBe(1);
});
