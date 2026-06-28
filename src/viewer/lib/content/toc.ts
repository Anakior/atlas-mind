// Table of contents over the already-rendered content DOM (not the markdown source). buildToc stays a
// top-level global — showMarkdown (06-view-history) and exitEditMode (09-editor) call it after setting
// contentEl.innerHTML. readingTimeFromWords is a sibling pure util read by the same showMarkdown.

import { tocList, contentEl, tocPanel } from '../core/dom-refs';
import { slugify } from '../core/utils';
import { layoutChrome } from '../home/layout-chrome';

export class Toc {
  // Build the right-panel TOC from the rendered h2/h3 (<2 headings → hide it); anchors smooth-scroll.
  buildToc(): void {
    tocList.innerHTML = '';

    const headings = contentEl.querySelectorAll<HTMLElement>('h2, h3');

    if (headings.length < 2) {
      tocList.classList.add('hidden'); // no table of contents → no empty area

      if (typeof layoutChrome.applyToc === 'function') layoutChrome.applyToc();
      else {
        tocPanel.classList.add('hidden');
        tocPanel.classList.remove('flex');
      }

      return;
    }

    tocList.classList.remove('hidden');

    const used = new Set<string>();

    headings.forEach((heading) => {
      let id = slugify(heading.textContent || '');
      let base = id,
        n = 2;

      while (used.has(id)) {
        id = base + '-' + n;
        n++;
      }

      used.add(id);
      heading.id = id;

      const a = document.createElement('a');

      a.href = '#' + id;
      a.textContent = heading.textContent;
      a.className =
        'block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent truncate ' +
        (heading.tagName === 'H3' ? 'pl-5 text-[11px] text-ink-400' : 'font-medium');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById(id)!.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      tocList.appendChild(a);
    });

    if (typeof layoutChrome.applyToc === 'function') layoutChrome.applyToc();
    else {
      tocPanel.classList.remove('hidden');
      tocPanel.classList.add('flex');
    }
  }
}

export const toc = new Toc();

// Reading-time estimate (≈220 wpm); shown in the breadcrumb by showMarkdown (06-view-history). Pure.
export function readingTimeFromWords(words: number | undefined): ReadingTime | null {
  if (!words) return null;

  const minutes = Math.max(1, Math.round(words / 220));

  return { words, minutes };
}
