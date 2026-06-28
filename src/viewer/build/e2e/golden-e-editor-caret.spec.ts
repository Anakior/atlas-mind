import { test, expect } from '@playwright/test';

// GOLDEN E — the editor textarea caret/selection survive the live preview re-render.
//
// Invariant: the split editor builds two sibling nodes, #md-editor (textarea) and
// #md-preview. The debounced input handler rewrites ONLY preview.innerHTML; the textarea
// is never recreated or touched (09-editor.js:456-462), so focus + selectionStart/End
// survive. The runtime rewrite must keep the textarea an untouched imperative island.
//
// We trigger the re-render with a no-op `input` event (value unchanged → caret can't move
// as a side effect of typing) and prove the re-render actually fired by first corrupting
// #md-preview with a sentinel the handler then overwrites.

test('E — editor caret/selection survive the preview re-render', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tree');
  await page.locator('#tree a[data-path="welcome.md"]').click();
  // Édit lives in the ⋯ actions menu (#btn-more-menu), hidden until opened.
  await page.locator('#btn-more').click();
  await page.locator('#btn-edit').click();

  const editor = page.locator('#md-editor');
  await editor.waitFor();

  // Place a non-trivial selection, corrupt the preview, then fire the re-render.
  await page.evaluate(() => {
    const ta = document.getElementById('md-editor') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(5, 10);
    document.getElementById('md-preview')!.innerHTML = '__SENTINEL__';
    ta.dispatchEvent(new Event('input'));
  });

  // Wait past the 150ms debounce: the handler overwrites the sentinel with renderMd().
  await page.waitForFunction(
    () => document.getElementById('md-preview')!.innerHTML !== '__SENTINEL__',
    null,
    { timeout: 2_000 },
  );

  const state = await page.evaluate(() => {
    const ta = document.getElementById('md-editor') as HTMLTextAreaElement;
    return {
      focused: document.activeElement === ta,
      start: ta.selectionStart,
      end: ta.selectionEnd,
      previewLen: document.getElementById('md-preview')!.innerHTML.length,
    };
  });

  expect(state.previewLen).toBeGreaterThan(0);  // re-render ran (sentinel gone)
  expect(state.focused).toBe(true);
  expect(state.start).toBe(5);
  expect(state.end).toBe(10);
});
