// The links of a rendered doc stay in Atlas: a [[wikilink]], a Markdown link to another doc
// ([x](other.md), made absolute by markdown.ts) and an anchor to one of the doc's own headings. A
// ctrl/cmd/shift-click or a link with a target keeps the browser's behaviour; links in the editor's
// live preview do nothing, so a click there never leaves the edit.

import { BASE } from '../core/data-csrf';
import { contentEl } from '../core/dom-refs';
import { fileMap } from '../core/tree';
import { currentFile } from '../core/state';
import { docRenderer, isViewable } from './doc-renderer';
import { DOC_ID_PREFIX } from './sanitize';

// A heading or element of the doc by the id its Markdown link uses ("#setup" → user-content-setup).
function scrollToAnchor(fragment: string): void {
  let id = fragment;

  try {
    id = decodeURIComponent(fragment);
  } catch (_) {
    /* a stray % stays as written */
  }
  document.getElementById(DOC_ID_PREFIX + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The doc an Atlas URL points to ("/base/notes/x.md" → fileMap["notes/x.md"]), if the viewer opens it.
function docAt(target: URL): FileNode | null {
  if (target.origin !== location.origin || !target.pathname.startsWith(BASE + '/')) return null;
  try {
    const f = fileMap[decodeURIComponent(target.pathname.slice(BASE.length + 1))];

    return f && isViewable(f.ext) ? f : null;
  } catch (_) {
    return null;
  }
}

contentEl.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');

  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  if (a.closest('#md-preview')) {
    e.preventDefault();

    return;
  }
  if (a.classList.contains('wikilink')) {
    e.preventDefault();
    const f = a.dataset.path ? fileMap[a.dataset.path] : undefined;

    if (f) void docRenderer.open(f);

    return;
  }

  const href = a.getAttribute('href');

  if (!href || (a.target && a.target !== '_self')) return;
  if (href.startsWith('#')) {
    e.preventDefault();
    scrollToAnchor(href.slice(1));

    return;
  }

  const target = new URL(href, location.href);
  const f = docAt(target);
  const here = !!f && f.path === currentFile?.path;

  // The open doc's own file without an anchor: the "open the original" links of a framed doc.
  if (!f || (here && !target.hash)) return;
  e.preventDefault();
  if (here) scrollToAnchor(target.hash.slice(1));
  else void docRenderer.open(f).then(() => target.hash && scrollToAnchor(target.hash.slice(1)));
});
