// Backlinks panel (#toc-links): incoming / outgoing wikilinks + same-topic (shared-tag) docs.
// Imperative DOM path (innerHTML / appendChild / addEventListener), NOT the keyed runtime.
//
// loadBacklinksIndex / renderBacklinksFor stay module-level functions over the `let` caches below
// (rather than a class) because boot/bootstrap.ts resets backlinksIndex / backlinksLoading on reload
// via the exported setters, and a class field can't be reassigned from another module (mirrors
// content-tree.ts's loadContent + contentCache). renderBacklinksFor's consumers (doc-renderer.ts,
// editor.ts) import it, and loadBacklinksIndex is read by graph/mind-graph.ts.

import { IS_OFFLINE_BUILD, EMBED_BACKLINKS } from '../core/data-csrf';
import { tocLinks } from '../core/dom-refs';
import { currentFile, tocHasLinks, setTocHasLinks } from '../core/state';
import { fileMap } from '../core/tree';
import { escapeHtml } from '../core/utils';
import { t } from '../core/i18n';
import { layoutChrome } from '../home/layout-chrome';
import { docRenderer } from './doc-renderer';

// Value type of backlinksIndex; single-file, so not promoted to interface/.
export interface BacklinkEntry {
  out: string[];
  in: string[];
}

// Lazy caches, reset to null by boot/bootstrap.ts on reload (via the exported setters) — hence module-level `let`s.
export let backlinksIndex: Record<string, BacklinkEntry> | null = null;

export function setBacklinksIndex(v: Record<string, BacklinkEntry> | null): void {
  backlinksIndex = v;
}

export let backlinksLoading: Promise<Record<string, BacklinkEntry>> | null = null;

export function setBacklinksLoading(v: Promise<Record<string, BacklinkEntry>> | null): void {
  backlinksLoading = v;
}

export async function loadBacklinksIndex(): Promise<Record<string, BacklinkEntry>> {
  if (backlinksIndex) return backlinksIndex;

  if (backlinksLoading) return backlinksLoading;
  backlinksLoading = (async () => {
    if (IS_OFFLINE_BUILD) {
      backlinksIndex = EMBED_BACKLINKS || {};
    } else {
      try {
        const res = await fetch('/_backlinks.json', { cache: 'no-cache' });

        backlinksIndex = res.ok ? await res.json() : {};
      } catch (e) {
        backlinksIndex = {};
      }
    }

    return backlinksIndex!;
  })();

  return backlinksLoading;
}

export async function renderBacklinksFor(file: FileNode): Promise<void> {
  // Synchronous reset (before the await): applyToc() from buildToc() will see a clean state.
  setTocHasLinks(false);

  if (tocLinks) {
    tocLinks.innerHTML = '';
    tocLinks.classList.remove('border-t', 'panel-divider');
  }

  const idx = await loadBacklinksIndex();

  if (currentFile !== file) return; // user changed page mid-load
  const entry = idx[file.path] || { out: [], in: [] };
  const resolve = (paths: string[] | undefined): FileNode[] =>
    (paths || []).map((p) => fileMap[p]).filter((f): f is FileNode => !!f);
  const incoming = resolve(entry.in);
  const outgoing = resolve(entry.out);
  // Same-topic docs: shared tags (excluding the current doc), ranked by shared-tag
  // count then recency.
  const tagSet = new Set(file.tags || []);
  const shared = (f: FileNode): number => (f.tags || []).filter((tg) => tagSet.has(tg)).length;
  const related = tagSet.size
    ? Object.values(fileMap)
        .filter((f) => f.ext === '.md' && f.path !== file.path && shared(f) > 0)
        .sort((a, b) => shared(b) - shared(a) || (b.mtime || 0) - (a.mtime || 0))
        .slice(0, 8)
    : [];

  setTocHasLinks(!!(incoming.length || outgoing.length || related.length));
  tocLinks.classList.toggle('hidden', !tocHasLinks); // empty section → no gap

  if (!tocHasLinks) {
    layoutChrome.applyToc();

    return;
  }

  const card = (f: FileNode): string =>
    '<a class="block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent cursor-pointer truncate" ' +
    'data-conn="' +
    escapeHtml(f.path) +
    '" title="' +
    escapeHtml(f.path) +
    '">' +
    escapeHtml(f.name) +
    '</a>';
  const group = (title: string, items: FileNode[]): string =>
    items.length
      ? '<div class="mt-2"><div class="px-2 pb-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-500 font-bold">' +
        title +
        '</div>' +
        items.map(card).join('') +
        '</div>'
      : '';

  tocLinks.classList.add('border-t', 'panel-divider');
  tocLinks.innerHTML =
    '<div class="px-2 pb-1 text-[10px] uppercase tracking-[0.12em] text-accent font-bold">' +
    t('linksTitle') +
    '</div>' +
    group(t('referencedBy', incoming.length), incoming) +
    group(t('outgoingLinks', outgoing.length), outgoing) +
    group(t('sameTopic', related.length), related);
  tocLinks.querySelectorAll('[data-conn]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[(a as HTMLElement).dataset.conn!];

      if (f) {
        docRenderer.show(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
  layoutChrome.applyToc();
}
