import { fileMap, docLabel } from '../core/tree';
import { escapeHtml, relativeDate } from '../core/utils';
import { sharedSection, sharedList, contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, tocPanel } from '../core/dom-refs';
import { IS_OFFLINE_BUILD, SITE_PREFIX, TAGLINE } from '../core/data-csrf';
import { t, LANG } from '../core/i18n';
import { currentFile, setCurrentFile, mdCount } from '../core/state';
import { todos, loadContent } from '../content/content-tree';
import { docRenderer, isViewable } from '../content/doc-renderer';
import { tagBrowsePage } from '../content/tag-browse';
import { Dialogs } from '../modals/dialogs';
import { newFileModal } from '../modals/new-file-modal';
import { tocShow } from './layout-chrome';

// Home dashboard + the viewer's hash router. The home view stays imperative innerHTML, NOT the keyed
// runtime: contentEl is co-owned by other content renderers (showMarkdown, renderHtmlFrame,
// openHistory), so a render()-based home would desync the runtime's per-container child map. HomeView
// is stateless; its entry points (showWelcome / routeFromHash / showNotFound) are public
// methods on the exported homeView singleton, imported by the modules that route and render (e.g. the
// command palette and bootstrap). Module scope keeps everything else private.
const TAGS_SHOWN = 30; // the home lists the most used tags; the rest is one click away

export class HomeView {
  // ---- home renderers (imperative innerHTML; see file header) ----
  // "Shared with me": docs another member shared WITH the viewer, discovered via
  // /api/shared-with-me. Cloud-only and fully defensive — any failure (offline build, local mode,
  // empty list, network error) just leaves the section hidden, so it can never break the home view.
  async renderSharedWithMe(): Promise<void> {
    if (IS_OFFLINE_BUILD || !location.protocol.startsWith('http')) return;

    let docs: unknown;

    try {
      const r = await fetch('/api/shared-with-me');

      if (!r.ok) return;
      docs = await r.json();
    } catch {
      return;
    }
    if (!Array.isArray(docs) || docs.length === 0) return;
    sharedSection.classList.remove('hidden');
    sharedList.innerHTML = docs
      .slice(0, 8)
      .map((d: { path: string; granted_by?: string }) => {
        const name = String(d.path).split('/').pop();
        const by = d.granted_by ? String(d.granted_by).replace(/^user:/, '') : '';

        return `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${escapeHtml(d.path)}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${by ? `<span class="text-[10px] text-ink-500">${escapeHtml(by)}</span>` : ''}
    </a></li>`;
      })
      .join('');
    sharedList.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const path = a.dataset.path;
        const f = path ? fileMap[path] : undefined;

        if (f) {
          docRenderer.show(f);
          history.replaceState(null, '', '#' + encodeURIComponent(f.path));
        }
      });
    });
  }

  showNotFound(path: string): void {
    // A doc the viewer can't reach (filtered out of the tree) or that doesn't exist: a clean in-app
    // page instead of silently bouncing to home. The wording is deliberately ambiguous (not-found OR
    // no-access) to keep the no-existence-oracle.
    setCurrentFile(null);
    contentEl.style.maxWidth = '';
    contentEl.style.padding = '';
    document.getElementById('todo-widget')?.classList.remove('hidden');
    // Reset the doc header/breadcrumb (path + mtime + actions) — else it would keep revealing the
    // path's existence and a "modified X ago" (an existence oracle).
    breadcrumbPath.textContent = '/';
    breadcrumbDate.textContent = '';
    breadcrumbActions.classList.add('hidden');
    breadcrumbActions.classList.remove('flex');
    tocPanel.classList.add('hidden');
    contentEl.innerHTML =
      '<div class="max-w-md mx-auto mt-24 text-center">' +
      '<div class="text-5xl mb-4 opacity-60">🔒</div>' +
      '<h1 class="text-xl font-semibold text-ink-100 mb-2 !border-0 !p-0">' +
      escapeHtml(t('notFoundTitle')) + '</h1>' +
      '<p class="text-sm text-ink-400 mb-1">' + escapeHtml(t('notFoundBody')) + '</p>' +
      '<p class="text-[11px] text-ink-500 font-mono mb-6 break-all">' + escapeHtml(path) + '</p>' +
      '<button id="nf-home" class="px-3 py-1.5 text-sm bg-accent hover:brightness-110 text-white rounded font-medium">' +
      escapeHtml(t('notFoundHome')) + '</button></div>';
    document.getElementById('nf-home')?.addEventListener('click', () => {
      history.replaceState(null, '', location.pathname);
      this.showWelcome();
    });
  }

  routeFromHash(): void {
    // Route from the URL hash once fileMap reflects the viewer's accessible docs.
    const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';

    if (!hash || hash === 'mind') {
      this.showWelcome();

      return;
    }
    // Something shared to the installed app (sw.js share target): a quick capture to keep.
    if (hash.startsWith('capture=')) {
      history.replaceState(null, '', location.pathname);
      this.showWelcome();
      newFileModal.openCapture(hash.slice('capture='.length));

      return;
    }

    const f = fileMap[hash];

    if (f && isViewable(f.ext)) {
      docRenderer.show(f);

      return;
    }
    if (f) {
      this.showWelcome();

      return;
    }
    // Not in the (per-viewer filtered) tree. Only declare "not found / no access" once the tree is
    // actually loaded (server mode loads it async via softReload) — before that, hold on the welcome
    // to avoid a false flash.
    if (Object.keys(fileMap).length) this.showNotFound(hash);
    else this.showWelcome();
  }

  showWelcome(): void {
    setCurrentFile(null);
    document.querySelector('main')!.scrollTop = 0; // a fresh home view starts at the top
    // Reset width/padding overrides left by a previous .html render (renderHtmlFrame), else the home
    // page inherits full-width; restore the todo widget hidden during the HTML preview. The home
    // itself runs wider than a doc.
    contentEl.style.maxWidth = '84rem';
    contentEl.style.padding = '26px 34px 120px';
    document.getElementById('todo-widget')?.classList.remove('hidden');

    const byCategory: Record<string, number> = {};
    let totalWords = 0;

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md') continue;
      const parts = f.path.split('/');
      const cat = parts.length >= 2 ? parts[0] + (parts.length >= 3 ? '/' + parts[1] : '') : 'root';

      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (f.words) totalWords += f.words;
    }

    const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const recent = Object.values(fileMap)
      .filter((f) => f.ext === '.md' && f.mtime)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 4);
    const todoSummary = todos.length ? `${todos.filter((td) => td.done).length}/${todos.length}` : '–';

    const ico = (d: string): string => `<svg class="side-i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    const folderTop = catEntries.slice(0, 5);
    const folderMax = folderTop.length ? folderTop[0][1] : 1;
    const folderBars = folderTop
      .map(([cat, n]) => `<div class="home-bar"><span class="home-bar-k">${escapeHtml(cat === 'root' ? t('rootLabel') : cat)}</span><span class="home-bar-t"><i style="width:${Math.round((100 * n) / folderMax)}%"></i></span><span class="home-bar-n">${n}</span></div>`)
      .join('');

    const recentItems = recent
      .map((f) => {
        const dir = f.path.split('/').slice(0, -1).join('/') || t('rootLabel');

        return `<a data-recent-path="${escapeHtml(f.path)}" class="home-row"><span class="home-row-t"><b>${escapeHtml(docLabel(f))}</b><em>${escapeHtml(dir)}</em></span><span class="home-row-w">${relativeDate(f.mtime)}</span></a>`;
      })
      .join('');

    const longest = Object.values(fileMap)
      .filter((f) => f.ext === '.md' && f.words)
      .sort((a, b) => (b.words ?? 0) - (a.words ?? 0))
      .slice(0, 3);
    const maxWords = longest.length ? longest[0].words ?? 1 : 1;
    const rankingHtml = longest
      .map((f) => {
        const words = f.words ?? 0;

        return `<a data-recent-path="${escapeHtml(f.path)}" class="home-bar home-bar-doc"><span class="home-bar-k">${escapeHtml(docLabel(f))}</span><span class="home-bar-t"><i style="width:${Math.max(4, Math.round((100 * words) / maxWords))}%"></i></span><span class="home-bar-n">${words.toLocaleString(LANG)}</span></a>`;
      })
      .join('');

    // Tag cloud: font size ∝ number of docs.
    const tagCounts: Record<string, number> = {};

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md') continue;

      for (const tag of f.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    const tagEntries = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const tagChip = ([tag, n]: [string, number]): string =>
      `<button type="button" class="home-tagc" data-hometag="${escapeHtml(tag)}">${escapeHtml(tag)}<i>${n}</i></button>`;
    const allTags = tagEntries.map(tagChip).join('');
    const tagCloud = tagEntries.slice(0, TAGS_SHOWN).map(tagChip).join('')
      + (tagEntries.length > TAGS_SHOWN ? `<button type="button" class="home-tagc home-tagc-more" data-tags-more>${t('tagsMore', tagEntries.length - TAGS_SHOWN)}</button>` : '');
    const kbd = (k: string, label: string): string => `<span><kbd>${k}</kbd> ${label}</span>`;

    contentEl.innerHTML = `
    <div class="home not-prose">
      <section class="home-hero">
        <div class="home-hero-l">
          <h1 class="home-mark"><span class="wm-prefix">${escapeHtml(SITE_PREFIX)}</span><span class="wm-atlas">Atlas</span><span class="nebula-pill">Mind</span></h1>
          <p class="home-tag">${escapeHtml(TAGLINE)}</p>
          <div class="home-stats">
            <div class="home-stat"><b>${mdCount}</b><span>${t('statDocs')}</span></div>
            <div class="home-stat"><b>${new Intl.NumberFormat(LANG, { notation: 'compact', maximumFractionDigits: 1 }).format(totalWords)}</b><span>${t('statWordsSub', Math.round(totalWords / 220))}</span></div>
            <div class="home-stat"><b id="home-todo-stat">${escapeHtml(todoSummary)}</b><span>${t('statTodoSub')}</span></div>
          </div>
        </div>
        <div id="activity-highlights" class="home-hero-r glass"></div>
      </section>

      <div id="home-connect" class="hidden"></div>
      <div id="home-backup" class="hidden"></div>

      <section id="home-activity-card" class="home-week">
        <div class="home-sec">
          <h2>${t('actTitle')}</h2>
          <div id="activity-ai" class="home-sec-end"></div>
        </div>
        <div class="home-grid">
          <section id="home-card-journal" class="home-card c7 r2">
            <header class="home-card-h"><h3>${ico('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>')}${t('actJournal')}</h3></header>
            <div id="activity-journal" class="home-card-b act-journal"></div>
          </section>
          <section id="home-card-orrery" class="home-card c5">
            <header class="home-card-h"><h3>${ico('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>')}${t('actConstellation')}</h3></header>
            <div id="activity-orrery" class="home-card-b"></div>
          </section>
          <section id="home-card-recent" class="home-card c5">
            <header class="home-card-h"><h3>${ico('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>')}${t('recentlyModified')}</h3></header>
            <div class="home-card-b home-rows">${recentItems || '<p class="home-empty">' + t('noRecentDocs') + '</p>'}</div>
          </section>
          ${IS_OFFLINE_BUILD ? '' : `<section id="home-card-inbox" class="home-card c4">
            <header class="home-card-h"><h3>${ico('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>')}${t('actInbox')}<span id="inbox-badge" class="side-badge hidden"></span></h3></header>
            <div id="activity-inbox" class="home-card-b"></div>
          </section>`}
          <section id="home-card-health" class="home-card ${IS_OFFLINE_BUILD ? 'c6' : 'c4'}">
            <header class="home-card-h"><h3>${ico('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>')}${t('actHealth')}</h3></header>
            <div id="activity-health" class="home-card-b"></div>
          </section>
          <section id="home-card-folders" class="home-card ${IS_OFFLINE_BUILD ? 'c6' : 'c4'}">
            <header class="home-card-h"><h3>${ico('<path d="M3 20h18"/><path d="M6 16V9M11 16V5M16 16v-4M21 16V8"/>')}${t('categories')} · ${t('longestDocs')}</h3></header>
            <div class="home-card-b home-bars">${folderBars}${rankingHtml ? '<div class="home-bars-gap"></div>' + rankingHtml : ''}</div>
          </section>
          <section id="home-card-tags" class="home-card c12">
            <header class="home-card-h"><h3>${ico('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>')}Tags</h3></header>
            <div class="home-card-b home-tags">${tagCloud || '<p class="home-empty">' + t('noTags') + '</p>'}</div>
          </section>
        </div>
      </section>

      <div class="home-keys">
        ${kbd('Ctrl+K', t('hintPalette'))}${kbd('/', t('hintSearch'))}${kbd('Ctrl+B', t('hintSidebar'))}${kbd('Ctrl+J', t('hintToc'))}${kbd('E', t('hintEdit'))}${kbd('N', t('hintNewTodo'))}
      </div>
    </div>
  `;
    contentEl.querySelectorAll<HTMLElement>('[data-recent-path]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const path = a.dataset.recentPath;
        const f = path ? fileMap[path] : undefined;

        if (f) {
          docRenderer.show(f);
          history.replaceState(null, '', '#' + encodeURIComponent(f.path));
        }
      });
    });
    contentEl.querySelector('#home-card-tags')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hometag], [data-tags-more]');

      if (!b) return;
      e.preventDefault();
      if (b.dataset.hometag) tagBrowsePage.showTag(b.dataset.hometag);
      else b.parentElement!.innerHTML = allTags;
    });

    // The week's cards (#home-activity-card) are filled by the activity module
    // (admin/activity/activity-boot.ts wires window.mountActivity to activity-card.ts), which also
    // refreshes them on SSE. Home only lays out the slots.
    if (window.mountActivity) window.mountActivity();

    breadcrumbPath.textContent = '/';
    breadcrumbDate.textContent = '';
    breadcrumbActions.classList.add('hidden');
    breadcrumbActions.classList.remove('flex');
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.add('hidden');
    window.dispatchEvent(new Event('atlas:home'));
  }
}

export const homeView = new HomeView();

homeView.renderSharedWithMe();

document.getElementById('home-link')!.addEventListener('click', () => {
  homeView.showWelcome();
  history.replaceState(null, '', location.pathname);
});

// Download the current doc as a file. Doc-action glue parked here pending relocation to the
// breadcrumb-action surface (plan item B15).
document.getElementById('btn-download')!.addEventListener('click', async () => {
  const file = currentFile;

  if (!file) return;

  // Non-.md: download the ORIGINAL served as-is — loadContent would return text and corrupt a
  // binary .pdf/.docx.
  if (file.ext !== '.md') {
    const fileUrl = '/' + file.path.split('/').map(encodeURIComponent).join('/');
    const a = document.createElement('a');

    a.href = fileUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    return;
  }

  let content: string;

  try {
    content = await loadContent(file);
  } catch (e) {
    Dialogs.notifyError('cantLoadDoc', (e as Error).message);

    return;
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
});
