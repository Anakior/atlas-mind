// Command palette (Ctrl+K): a fuzzy command/file picker plus async full-text search (the same engine
// as the search bar, via getSearchHits). Keeps its imperative DOM (innerHTML + rebind), byte-for-
// behaviour with the pre-migration view. The app-wide keyboard router that opens it lives in
// 12b-shortcuts.ts (it dispatches to overlays owned by 06/12, so it loads after them).

import { t } from '../core/i18n';
import { currentFile, editMode } from '../core/state';
import { searchEl } from '../core/dom-refs';
import { fileMap } from '../core/tree';
import { escapeHtml } from '../core/utils';
import { homeView } from '../home/home-view';
import { layoutChrome } from '../home/layout-chrome';
import { editor } from '../editor/editor';
import { search } from '../editor/search';
import { docRenderer } from '../content/doc-renderer';
import { mindGraph } from './graph-boot';

export class CommandPalette {
  private backdrop = document.getElementById('palette-backdrop')!;
  private input = document.getElementById('palette-input') as HTMLInputElement;
  private list = document.getElementById('palette-list')!;
  private count = document.getElementById('palette-count')!;

  private items: PaletteItem[] = [];
  private idx = 0;
  private nav: PaletteItem[] = []; // actions + files matched by name/path (instant)
  private content: PaletteItem[] = []; // files matched by content (async, via getSearchHits)
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;

  private static readonly ICON_PATHS: Record<string, string> = {
    home: 'M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-7h6v7h3a1 1 0 001-1V10',
    sidebar: 'M4 6h16M4 12h7M4 18h16',
    toc: 'M4 6h16M4 12h16M4 18h7',
    edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
    search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    reload:
      'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    file: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    graph:
      'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  };

  // Static command rows. Built once at load (i18n labels are fixed for the session, as before); the
  // closures capture `this` for the palette-close actions, so this is an instance field, not static.
  private actions: PaletteItem[];

  constructor() {
    this.actions = [
      {
        kind: 'action',
        label: t('actHome'),
        hint: t('actHomeHint'),
        icon: 'home',
        action: () => {
          homeView.showWelcome();
          history.replaceState(null, '', location.pathname);
        },
      },
      { kind: 'action', label: t('actSidebar'), hint: 'Ctrl+B', icon: 'sidebar', action: () => layoutChrome.toggleSidebar() },
      { kind: 'action', label: t('actToc'), hint: 'Ctrl+J', icon: 'toc', action: () => layoutChrome.toggleToc() },
      {
        kind: 'action',
        label: t('actEdit'),
        hint: 'E',
        icon: 'edit',
        action: () => {
          if (currentFile && !editMode) editor.enterEditMode();
        },
      },
      {
        kind: 'action',
        label: t('actDownload'),
        hint: '',
        icon: 'download',
        action: () => {
          if (currentFile) document.getElementById('btn-download')!.click();
        },
      },
      {
        kind: 'action',
        label: t('actSearch'),
        hint: '/',
        icon: 'search',
        action: () => {
          this.close();
          searchEl.focus();
        },
      },
      {
        kind: 'action',
        label: t('actGraph'),
        hint: 'Ctrl+G',
        icon: 'graph',
        action: () => {
          this.close();
          mindGraph.open();
        },
      },
      { kind: 'action', label: t('actReload'), hint: 'F5', icon: 'reload', action: () => location.reload() },
    ];

    this.input.addEventListener('input', (e) => this.renderResults((e.target as HTMLInputElement).value));
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  open(): void {
    this.backdrop.classList.remove('hidden');
    this.input.value = '';
    this.renderResults('');
    setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    this.backdrop.classList.add('hidden');
  }

  private iconSvg(name: string): string {
    const p = CommandPalette.ICON_PATHS[name] || CommandPalette.ICON_PATHS.file;

    return (
      '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="' +
      p +
      '"/></svg>'
    );
  }

  private renderResults(q: string): void {
    const rawQuery = q.trim();

    q = rawQuery.toLowerCase();
    // Instant pass: actions + files matched by name/path.
    const nav: PaletteItem[] = [];

    for (const a of this.actions) {
      if (!q || a.label.toLowerCase().includes(q)) nav.push(a);
    }

    const seen = new Set<string>();

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md') continue;

      if (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) {
        nav.push({ kind: 'file', label: f.name, hint: f.path, file: f, query: rawQuery });
        seen.add(f.path);
      }
    }

    this.nav = nav;
    this.content = [];
    this.paint();
    // Async pass: full-text content search via getSearchHits (same engine as the search bar).
    // Debounced; skips files already listed by name/path.
    const seq = ++this.searchSeq;

    if (this.searchDebounce) clearTimeout(this.searchDebounce);

    if (q.length >= 2) {
      this.searchDebounce = setTimeout(async () => {
        let hits: Awaited<ReturnType<typeof search.getSearchHits>>;

        try {
          hits = await search.getSearchHits(rawQuery);
        } catch (e) {
          return;
        }

        if (seq !== this.searchSeq) return; // stale request, we bail out
        const extra: PaletteItem[] = [];

        for (const hit of hits) {
          if (seen.has(hit.path)) continue;
          const f = fileMap[hit.path];

          if (f) extra.push({ kind: 'file', label: f.name, hint: f.path, file: f, snippet: hit.snippet, query: rawQuery });
        }

        this.content = extra;
        this.paint();
      }, 160);
    }
  }

  private paint(): void {
    const items = this.nav.concat(this.content);

    this.items = items.slice(0, 30);
    this.idx = 0;
    this.count.textContent =
      items.length > 30 ? t('paletteResultsCapped', items.length) : t('nResults', items.length);
    this.list.innerHTML = this.items
      .map((item, i) => {
        const secondary = item.snippet
          ? '<div class="text-[10px] text-ink-400 truncate">' + escapeHtml(item.snippet) + '</div>'
          : item.hint
            ? '<div class="text-[10px] text-ink-500 truncate font-mono">' + escapeHtml(item.hint) + '</div>'
            : '';
        const kbd =
          item.kind === 'action' && item.hint
            ? '<kbd class="text-[10px] text-ink-500 bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">' +
              escapeHtml(item.hint) +
              '</kbd>'
            : '';

        return `
    <li data-idx="${i}" class="palette-item flex items-center gap-3 px-4 py-2.5 cursor-pointer ${i === 0 ? 'palette-active' : ''}">
      <span class="text-ink-400">${this.iconSvg(item.icon || (item.kind === 'file' ? 'file' : 'edit'))}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm text-ink-100 truncate">${escapeHtml(item.label)}</div>
        ${secondary}
      </div>
      ${kbd}
    </li>`;
      })
      .join('');
    this.list.querySelectorAll('.palette-item').forEach((el, i) => {
      el.addEventListener('mouseenter', () => {
        this.idx = i;
        this.updateHighlight();
      });
      el.addEventListener('click', () => this.select(i));
    });
  }

  private updateHighlight(): void {
    this.list.querySelectorAll('.palette-item').forEach((li, i) => {
      li.classList.toggle('palette-active', i === this.idx);
    });
    const active = this.list.querySelector('.palette-active');

    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  private select(i: number): void {
    const item = this.items[i];

    if (!item) return;
    this.close();

    if (item.kind === 'action') item.action!();
    else if (item.kind === 'file') {
      docRenderer.show(item.file!, item.query);
      history.replaceState(null, '', '#' + encodeURIComponent(item.file!.path));
    }
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.idx = Math.min(this.items.length - 1, this.idx + 1);
      this.updateHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.idx = Math.max(0, this.idx - 1);
      this.updateHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.select(this.idx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }
}

export const commandPalette = new CommandPalette();
