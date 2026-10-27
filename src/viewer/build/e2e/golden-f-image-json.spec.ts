import { test, expect, type Page } from '@playwright/test';

// GOLDEN F — an image and a .json open IN the viewer (they used to be bare links to the raw file).
//
// An image is fitted to the pane through <img> (so an .svg never runs a script) and its size shows
// in the banner once loaded; a .json is pretty-printed and highlighted under a one-line summary,
// and an invalid one is shown as is under its parse error. The tree is mocked (like golden B) and
// so are the files, served by route().

// A 3×2 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4YaMBQQxwFgBKJAcJKumIJAAAAABJRU5ErkJggg==',
  'base64',
);

function file(path: string, ext: string) {
  return { name: path.split('/').pop(), type: 'file', path, ext, mtime: 1781890000, tags: [] };
}
const tree = {
  name: 'root', type: 'dir',
  children: [{ name: 'media', type: 'dir', children: [
    file('media/logo.png', '.png'), file('media/stats.json', '.json'), file('media/broken.json', '.json'),
  ] }],
};

// The viewer's service worker fetches files itself once active, out of route()'s reach.
test.use({ serviceWorkers: 'block' });

async function open(page: Page, path: string) {
  await page.locator(`#tree a[data-path="${path}"]`).click();
}

test('F — images and JSON render in the viewer', async ({ page }) => {
  await page.route('**/api/tree', (route) => route.fulfill({ json: tree }));
  // By path: the viewer adds a ?v=<mtime> cache-buster.
  const at = (path: string) => (url: URL) => url.pathname === path;
  await page.route(at('/media/logo.png'), (route) => route.fulfill({ body: PNG, contentType: 'image/png' }));
  await page.route(at('/media/stats.json'), (route) =>
    route.fulfill({ body: '{"name":"atlas","items":[1,2,3]}', contentType: 'application/json' }));
  await page.route(at('/media/broken.json'), (route) =>
    route.fulfill({ body: '{"a": 1,,}', contentType: 'application/json' }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tree');
  await page.evaluate(() => window.softReload());

  await open(page, 'media/logo.png');
  const img = page.locator('#content .image-doc img');
  await expect(img).toBeVisible();
  await expect(page.locator('#content [data-banner-label]')).toContainText('3 × 2 px');
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(3);

  await open(page, 'media/stats.json');
  await expect(page.locator('#content .json-doc-summary')).toContainText(/2 (clés|keys)/);
  await expect(page.locator('#content .json-doc code.language-json .hljs-attr').first()).toHaveText('"name"');
  await expect(page.locator('#content .json-doc pre')).toContainText('"items": [\n    1,');

  await open(page, 'media/broken.json');
  await expect(page.locator('#content .json-doc-summary--invalid')).toBeVisible();
  await expect(page.locator('#content .json-doc pre')).toContainText('{"a": 1,,}');
});
