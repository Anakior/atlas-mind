import { fileMap } from '../core/tree';
import { escapeHtml, relativeDate } from '../core/utils';
import { recentSection, recentList, sharedSection, sharedList, contentEl, breadcrumbPath, breadcrumbDate, breadcrumbActions, tocPanel } from '../core/dom-refs';
import { IS_OFFLINE_BUILD, SITE_PREFIX, TAGLINE } from '../core/data-csrf';
import { t, LANG } from '../core/i18n';
import { currentFile, setCurrentFile, mdCount } from '../core/state';
import { todos, loadContent } from '../content/content-tree';
import { docRenderer } from '../content/doc-renderer';
import { tagBrowsePage } from '../content/tag-browse';
import { mindGraph } from '../graph/graph-boot';
import { Dialogs } from '../modals/dialogs';
import { tocShow } from './layout-chrome';

// Home dashboard + the viewer's hash router. The home view stays imperative innerHTML, NOT the keyed
// runtime: contentEl is co-owned by other content renderers (showMarkdown, renderHtmlFrame,
// openHistory), so a render()-based home would desync the runtime's per-container child map. HomeView
// is stateless; its entry points (showWelcome / routeFromHash / showNotFound / renderRecent) are public
// methods on the exported homeView singleton, imported by the modules that route and render (e.g. the
// command palette and bootstrap). Module scope keeps everything else private.
export class HomeView {
  // ---- home renderers (imperative innerHTML; see file header) ----
  renderRecent(): void {
    const files = Object.values(fileMap)
      .filter((f) => f.ext === '.md' && f.mtime)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    if (files.length === 0) return;
    recentSection.classList.remove('hidden');
    recentList.innerHTML = files
      .map(
        (f) => `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${escapeHtml(f.path)}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="text-[10px] text-ink-500">${relativeDate(f.mtime)}</span>
    </a></li>
  `,
      )
      .join('');
    recentList.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
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

    const f = fileMap[hash];

    if (f && f.ext === '.md') {
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
    // page inherits full-width; restore the todo widget hidden during the HTML preview.
    contentEl.style.maxWidth = '';
    contentEl.style.padding = '';
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

    // Docs modified this week vs last, for the "this week" stat delta.
    const dayMs = 86400 * 1000;
    const now = new Date();

    now.setHours(0, 0, 0, 0);
    const todayDow = (now.getDay() + 6) % 7;
    const monday = new Date(now.getTime() - todayDow * dayMs);
    const startOfThisWeek = monday.getTime() / 1000;
    const startOfPrevWeek = (monday.getTime() - 7 * dayMs) / 1000;
    let weekModif = 0;
    let prevWeekModif = 0;

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md' || !f.mtime) continue;
      if (f.mtime >= startOfThisWeek) weekModif += 1;
      else if (f.mtime >= startOfPrevWeek) prevWeekModif += 1;
    }

    const weekDelta = weekModif - prevWeekModif;
    const weekDeltaTxt = weekDelta === 0 ? '=' : (weekDelta > 0 ? '+' : '') + weekDelta;
    const weekDeltaColor = weekDelta > 0 ? '#4ade80' : weekDelta < 0 ? '#f87171' : '#868a90';

    const categoryItems = catEntries
      .map(([cat, n]) => {
        return (
          '<div class="flex items-center justify-between px-3 py-2 rounded border subtle-border bg-black/15 hover:bg-black/25 transition"><span class="text-sm text-ink-200 font-mono truncate">' +
          escapeHtml(cat) +
          '</span><span class="text-xs text-ink-400 font-semibold ml-2">' +
          n +
          '</span></div>'
        );
      })
      .join('');

    const recentItems = recent
      .map((f) => {
        return (
          '<a data-recent-path="' +
          escapeHtml(f.path) +
          '" class="block p-3 rounded-lg border subtle-border bg-black/15 hover:bg-black/30 hover:border-accent/30 transition cursor-pointer">' +
          '<div class="text-sm text-ink-100 font-medium font-sans truncate">' +
          escapeHtml(f.name) +
          '</div>' +
          '<div class="text-[11px] text-ink-500 mt-0.5 font-sans">' +
          relativeDate(f.mtime) +
          ' · ' +
          escapeHtml(f.path.split('/').slice(0, -1).join('/') || t('rootLabel')) +
          '</div>' +
          '</a>'
        );
      })
      .join('');

    const longest = Object.values(fileMap)
      .filter((f) => f.ext === '.md' && f.words)
      .sort((a, b) => (b.words ?? 0) - (a.words ?? 0))
      .slice(0, 6);
    const maxWords = longest.length ? longest[0].words ?? 1 : 1;
    const rankingHtml = longest.length
      ? longest
          .map((f, i) => {
            const words = f.words ?? 0;
            const pct = Math.max(4, Math.round((100 * words) / maxWords));

            return (
              '<a data-recent-path="' +
              escapeHtml(f.path) +
              '" class="block cursor-pointer group">' +
              '<div class="flex items-center gap-2">' +
              '<span class="text-ink-500 font-mono text-xs w-4 text-right">' +
              (i + 1) +
              '</span>' +
              '<span class="text-sm text-ink-200 group-hover:text-accent truncate flex-1">' +
              escapeHtml(f.name) +
              '</span>' +
              '<span class="text-[11px] text-ink-500 font-mono whitespace-nowrap">' +
              words.toLocaleString(LANG) +
              '</span>' +
              '</div>' +
              '<div class="h-1 mt-1 ml-6 rounded bg-black/30 overflow-hidden"><div class="h-full rounded" style="width:' +
              pct +
              '%;background:rgba(29,155,209,0.55)"></div></div>' +
              '</a>'
            );
          })
          .join('')
      : '<span class="text-sm text-ink-500">—</span>';

    // Tag cloud: font size ∝ number of docs.
    const tagCounts: Record<string, number> = {};

    for (const f of Object.values(fileMap)) {
      if (f.ext !== '.md') continue;

      for (const tag of f.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    const tagEntries = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const maxTagCount = tagEntries.length ? tagEntries[0][1] : 1;
    const tagCloud = tagEntries
      .map(([tag, n]) => {
        const scale = (0.78 + 0.5 * (n / maxTagCount)).toFixed(2);

        return (
          '<button class="doc-tag" data-hometag="' +
          escapeHtml(tag) +
          '" style="font-size:' +
          scale +
          'rem">#' +
          escapeHtml(tag) +
          '<span class="doc-tag-count">' +
          n +
          '</span></button>'
        );
      })
      .join('');

    contentEl.innerHTML = `
    <h1 class="!mb-2"><span style="font-family:'Corinthia',cursive;font-weight:700;font-size:1.7em;line-height:.9;color:#eef0f2">${escapeHtml(SITE_PREFIX)}</span> <span style="display:inline-flex;align-items:center;gap:.4em;line-height:1;margin-left:.22em"><span style="font-family:'Lora',Georgia,serif;font-style:italic;font-weight:600;font-size:1.3em;color:#e8941c;text-shadow:0 1px 2px rgba(0,0,0,0.6),0 0 1px rgba(0,0,0,0.85)">Atlas</span><span class="nebula-pill">Mind</span></span></h1>
    <p class="lead text-ink-400 !mt-0">${escapeHtml(TAGLINE)}</p>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mt-6 mb-8">
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statDocs')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${mdCount}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statDocsSub')}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statWords')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${(totalWords / 1000).toFixed(1)}k</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statWordsSub', Math.round(totalWords / 220))}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">${t('statWeek')}</div>
        <div class="text-3xl font-extrabold text-accent mt-1 font-sans">${weekModif} <span class="text-sm font-bold ml-1" style="color:${weekDeltaColor}">${weekDeltaTxt}</span></div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statWeekSub')}</div>
      </div>
      <div class="border subtle-border rounded-lg p-4 bg-black/15">
        <div class="text-[10px] uppercase tracking-wider text-ink-500 font-semibold">To-do</div>
        <div id="home-todo-stat" class="text-3xl font-extrabold text-accent mt-1 font-sans">${escapeHtml(todoSummary)}</div>
        <div class="text-[11px] text-ink-400 mt-0.5">${t('statTodoSub')}</div>
      </div>
    </div>

    <div class="not-prose mb-10" id="home-activity-mount"></div>

    <div class="not-prose mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="!mb-0 !mt-0">Tags</h2>
        <button id="home-graph-btn" class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-navy-600 hover:bg-navy-500 text-ink-100 rounded-lg border subtle-border transition" title="${t('graphBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>${t('graphLabel')}</button>
      </div>
      <div class="doc-tags">${tagCloud || '<span class="text-sm text-ink-500">' + t('noTags') + '</span>'}</div>
    </div>

    <h2 class="!mt-0 !mb-4">${t('recentlyModified')}</h2>
    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-3 mb-10">${recentItems || '<div class="text-sm text-ink-500">' + t('noRecentDocs') + '</div>'}</div>

    <div class="not-prose grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
      <div>
        <h2 class="!mb-4 !mt-0">${t('categories')}</h2>
        <div class="grid grid-cols-1 gap-2">${categoryItems}</div>
      </div>
      <div>
        <h2 class="!mb-4 !mt-0">${t('longestDocs')}</h2>
        <div class="space-y-2.5">${rankingHtml}</div>
      </div>
    </div>

    <div class="not-prose mt-8 text-xs text-ink-500 flex flex-wrap gap-x-4 gap-y-2 items-center">
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+K</kbd> ${t('hintPalette')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">/</kbd> ${t('hintSearch')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+B</kbd> ${t('hintSidebar')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">Ctrl+J</kbd> ${t('hintToc')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">E</kbd> ${t('hintEdit')}</span>
      <span><kbd class="bg-black/30 border subtle-border px-1.5 py-0.5 rounded font-mono">N</kbd> ${t('hintNewTodo')}</span>
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
    contentEl.querySelectorAll<HTMLElement>('[data-hometag]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (b.dataset.hometag) tagBrowsePage.showTag(b.dataset.hometag);
      }),
    );

    const homeGraphBtn = contentEl.querySelector('#home-graph-btn');

    if (homeGraphBtn) homeGraphBtn.addEventListener('click', () => mindGraph.open());
    // The Activity island (#home-activity-mount) is owned by the activity module
    // (admin/activity/activity-boot.ts wires window.mountActivity to activity-card.ts): it fills the
    // empty mount and re-mounts on SSE. Home only leaves the slot for it.
    if (window.mountActivity) window.mountActivity();

    breadcrumbPath.textContent = '/';
    breadcrumbDate.textContent = '';
    breadcrumbActions.classList.add('hidden');
    breadcrumbActions.classList.remove('flex');
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.add('hidden');
  }
}

export const homeView = new HomeView();

homeView.renderRecent();
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
