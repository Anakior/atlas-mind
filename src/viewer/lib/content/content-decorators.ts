// Post-render decorators of the #content markdown body — hooks run after each innerHTML write:
//   • attachCopyButtons   — adds the hover copy button to every <pre> code block (doc-renderer.ts /
//                           editor.ts after a render).
//   • highlightFirstMatch — highlights + scrolls to the 1st occurrence of a search term (doc-renderer.ts
//                           / graph/tasks-overlay.ts).
//
// Both are cross-cutting (neither belongs to the notes nor the tags concern), so they live here as
// module exports their consumers import.

import { contentEl } from '../core/dom-refs';
import { t } from '../core/i18n';

export function attachCopyButtons(): void {
  contentEl.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    pre.style.position = 'relative';
    const btn = document.createElement('button');

    btn.className =
      'copy-btn absolute top-2 right-2 opacity-0 transition-opacity px-2 py-1 text-[11px] bg-white/8 hover:bg-white/15 text-ink-300 hover:text-white rounded font-mono';
    btn.innerHTML =
      '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' +
      t('copy');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const codeEl = pre.querySelector('code');
      const code = (codeEl ? codeEl.textContent : pre.textContent) ?? '';

      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML =
          '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' +
          t('copied');
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerHTML =
            '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' +
            t('copy');
          btn.classList.remove('text-emerald-400');
        }, 1500);
      } catch (e) {}
    });
    pre.appendChild(btn);
    pre.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    pre.addEventListener('mouseleave', () => (btn.style.opacity = '0'));
  });
}

// Highlights + scrolls to the 1st occurrence of a search term in the rendered doc. Walks text nodes
// to avoid breaking marked's HTML. Case-insensitive; on an accent mismatch there's no match and the
// scroll stays at the top.
export function highlightFirstMatch(container: Element, query: string): void {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length >= 2)
    .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!tokens.length) return;

  const re = new RegExp('(' + tokens.join('|') + ')', 'i');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue && re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const node = walker.nextNode() as Text | null;

  if (!node) return;

  const value = node.nodeValue;

  if (value == null) return;

  const m = value.match(re);

  if (!m) return;

  const after = node.splitText(m.index!);

  after.nodeValue = after.nodeValue!.slice(m[0].length);
  const mark = document.createElement('mark');

  mark.className = 'search-hit';
  mark.textContent = m[0];
  after.parentNode!.insertBefore(mark, after);
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
