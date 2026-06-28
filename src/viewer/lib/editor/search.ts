// Full-text search exposed as the `search` singleton: the command palette (graph/command-palette.ts)
// calls getSearchHits, and boot/bootstrap.ts resets miniSearch/searchInitPromise (via setMiniSearch /
// setSearchInitPromise) to invalidate the offline index.
//
// Search runs MiniSearch offline (file:// monolith, lazy-loaded on the first query) and /api/search
// online, normalizes both engines to NormalizedHit[], and renders the results pane under the tree.
// makeSnippet stays a pure helper (the highlighted excerpt around the first matching word).

import { searchEl, searchResultsEl, treeEl, recentList, recentSection } from '../core/dom-refs';
import { t } from '../core/i18n';
import { fileMap } from '../core/tree';
import { EMBED_CONTENT, IS_OFFLINE_BUILD } from '../core/data-csrf';
import { escapeHtml } from '../core/utils';
import { docRenderer } from '../content/doc-renderer';

// MiniSearch index + its in-flight init promise. Module-level state (NOT class state) so
// boot/bootstrap.ts can reset both via setMiniSearch / setSearchInitPromise on softReload to
// invalidate the index. Lazy-loaded on the first offline search.
export let miniSearch: any = null;
export let searchInitPromise: Promise<any> | null = null;

export function setMiniSearch(v: any): void {
  miniSearch = v;
}

export function setSearchInitPromise(v: Promise<any> | null): void {
  searchInitPromise = v;
}

export class Search {
  private static readonly SEARCH_FIELDS = ['name', 'path', 'content'];
  private static readonly SEARCH_STORE = ['name', 'path', 'preview'];

  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  // The "FILES" header above the tree, hidden alongside the tree while a query is active.
  private treeHeaderEl = document.getElementById('tree-header');

  constructor() {
    searchEl.addEventListener('input', () => this.onSearchInput());
  }

  // Local lib (/vendor/); in an offline build (file://) it's inlined into the
  // monolith by build.py, so the typeof short-circuits — no fetch.
  private async loadMiniSearchLib(): Promise<void> {
    if (typeof MiniSearch !== 'undefined') return;
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');

      s.src = '/vendor/minisearch.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(t('cdnFailMiniSearch')));
      document.head.appendChild(s);
    });
  }

  // MiniSearch is only used in offline builds (file://, no server). Online,
  // search goes through /api/search. We index the already-embedded content.
  private async getSearchData(): Promise<MiniSearchDoc[]> {
    const docs: MiniSearchDoc[] = [];

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md') continue;
      const c = EMBED_CONTENT![f.path] || '';

      docs.push({ id: f.path, name: f.name, path: f.path, content: c, preview: c.slice(0, 240) });
    }

    return docs;
  }

  private async initMiniSearch(): Promise<any> {
    if (miniSearch) return miniSearch;

    if (searchInitPromise) return searchInitPromise;
    searchInitPromise = (async () => {
      await this.loadMiniSearchLib();
      const docs = await this.getSearchData();
      const ms = new MiniSearch({
        idField: 'id',
        fields: Search.SEARCH_FIELDS,
        storeFields: Search.SEARCH_STORE,
        searchOptions: {
          boost: { name: 3, path: 2 },
          fuzzy: 0.2,
          prefix: true,
          combineWith: 'AND',
        },
        tokenize: (text: string) =>
          text
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
        processTerm: (term: string) => term.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
      });

      ms.addAll(docs);
      miniSearch = ms;

      return ms;
    })();

    return searchInitPromise;
  }

  // Online: server-side search (/api/search) → transfer O(results), nothing to
  // download. Offline (file:// monolith): MiniSearch over the embedded content.
  // Each branch returns a normalized array [{path, snippet}].
  async getSearchHits(q: string): Promise<NormalizedHit[]> {
    if (IS_OFFLINE_BUILD) {
      const ms = await this.initMiniSearch();
      const matches = ms.search(q, { boost: { name: 3, path: 2 }, fuzzy: 0.2, prefix: true });

      return matches.map((m: { path: string; preview?: string }) => ({
        path: m.path,
        snippet: makeSnippet(m.preview || '', q),
      }));
    }

    const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=50', {
      cache: 'no-store',
    });

    if (!res.ok) throw new Error('search HTTP ' + res.status);
    const hits = (await res.json()) as SearchHit[];

    return hits.map((h) => ({ path: h.path, snippet: h.snippet || '' }));
  }

  private async renderSearchResults(q: string): Promise<void> {
    searchResultsEl.innerHTML =
      '<div class="px-3 py-4 text-xs text-ink-500">' + t('searching') + '</div>';
    let hits: NormalizedHit[];

    try {
      hits = await this.getSearchHits(q);
    } catch (e) {
      searchResultsEl.innerHTML =
        '<div class="px-3 py-4 text-xs text-rose-400">' +
        escapeHtml(t('err', (e as Error).message)) +
        '</div>';

      return;
    }

    if ((searchEl as HTMLInputElement).value.trim() !== q) return; // user typed something else in the meantime

    if (hits.length === 0) {
      searchResultsEl.innerHTML =
        '<div class="px-3 py-4 text-xs text-ink-500">' + escapeHtml(t('noResults', q)) + '</div>';

      return;
    }

    const top = hits.slice(0, 50);

    searchResultsEl.innerHTML =
      '<div class="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">' +
      t('nResults', hits.length) +
      (hits.length > 50 ? t('cappedSuffix') : '') +
      '</div>';
    const tokens = q
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .split(/\s+/)
      .filter(Boolean);
    const highlightRe = tokens.length ? new RegExp('(' + tokens.join('|') + ')', 'gi') : null;

    for (const m of top) {
      const file = fileMap[m.path];

      if (!file) continue;
      const a = document.createElement('a');

      a.className = 'tree-item block px-2 py-1.5 rounded cursor-pointer text-ink-200 mb-0.5';
      a.dataset.path = file.path;
      const snippet = m.snippet;
      const snippetHtml =
        snippet && highlightRe
          ? '<div class="text-[11px] text-ink-400 mt-0.5 leading-snug">' +
            escapeHtml(snippet).replace(
              highlightRe,
              '<mark class="bg-blue-500/30 text-blue-200 rounded px-0.5">$1</mark>',
            ) +
            '</div>'
          : '';

      a.innerHTML =
        '<div class="text-sm font-medium text-ink-100 truncate">' +
        escapeHtml(file.name) +
        '</div><div class="text-[10px] text-ink-500">' +
        file.path +
        '</div>' +
        snippetHtml;

      if (file.ext === '.md' || file.ext === '.html') {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          docRenderer.show(file, q);
        });
      } else {
        a.href = encodeURI(file.path);
      }

      searchResultsEl.appendChild(a);
    }
  }

  private onSearchInput(): void {
    const q = (searchEl as HTMLInputElement).value.trim();

    if (this.searchDebounce) clearTimeout(this.searchDebounce);

    if (!q) {
      searchResultsEl.classList.add('hidden');
      treeEl.classList.remove('hidden');
      if (this.treeHeaderEl) this.treeHeaderEl.classList.remove('hidden');

      if (recentList.children.length > 0) recentSection.classList.remove('hidden');

      return;
    }

    treeEl.classList.add('hidden');
    if (this.treeHeaderEl) this.treeHeaderEl.classList.add('hidden');
    recentSection.classList.add('hidden');
    searchResultsEl.classList.remove('hidden');
    this.searchDebounce = setTimeout(() => this.renderSearchResults(q), 140);
  }
}

// Pure: the highlighted excerpt around the first matching query word (or a head slice if none).
export function makeSnippet(preview: string, query: string): string {
  if (!preview) return '';
  const words = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const lower = preview.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let idx = -1,
    term: string | null = null;

  for (const w of words) {
    const i = lower.indexOf(w);

    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      term = w;
    }
  }

  if (idx < 0) return preview.slice(0, 160) + (preview.length > 160 ? '…' : '');
  const start = Math.max(0, idx - 40);
  const end = Math.min(preview.length, idx + term!.length + 80);

  return (start > 0 ? '…' : '') + preview.slice(start, end) + (end < preview.length ? '…' : '');
}

export const search = new Search();
