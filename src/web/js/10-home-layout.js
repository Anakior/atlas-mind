function renderRecent() {
  const files = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && f.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  if (files.length === 0) return;
  recentSection.classList.remove('hidden');
  recentList.innerHTML = files
    .map(
      (f) => `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${f.path}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="text-[10px] text-ink-500">${relativeDate(f.mtime)}</span>
    </a></li>
  `,
    )
    .join('');
  recentList.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.path];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
}

renderRecent();

// "Shared with me": docs another member shared WITH the viewer, discovered
// via /api/shared-with-me. Cloud-only and fully defensive — any failure (offline
// build, local mode, empty list, network error) just leaves the section hidden, so
// it can never break the home view.
async function renderSharedWithMe() {
  if (!sharedSection || IS_OFFLINE_BUILD || !location.protocol.startsWith('http')) return;
  let docs;
  try {
    const r = await fetch('/api/shared-with-me');
    if (!r.ok) return;
    docs = await r.json();
  } catch (e) {
    return;
  }
  if (!Array.isArray(docs) || docs.length === 0) return;
  sharedSection.classList.remove('hidden');
  sharedList.innerHTML = docs
    .slice(0, 8)
    .map((d) => {
      const name = String(d.path).split('/').pop();
      const by = d.granted_by ? String(d.granted_by).replace(/^user:/, '') : '';
      return `
    <li class="overflow-hidden"><a class="tree-item w-full flex flex-col px-2 py-1 rounded cursor-pointer" data-path="${escapeHtml(d.path)}">
      <span class="block text-xs text-ink-200 truncate w-full" data-name="${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${by ? `<span class="text-[10px] text-ink-500">${escapeHtml(by)}</span>` : ''}
    </a></li>`;
    })
    .join('');
  sharedList.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.path];
      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
}

renderSharedWithMe();

// Custom tooltip for truncated filenames
const tooltipEl = document.createElement('div');

tooltipEl.className =
  'fixed pointer-events-none bg-navy-800/95 border subtle-border text-ink-100 text-xs px-3 py-1.5 rounded-md shadow-2xl shadow-black/70 z-50 opacity-0 max-w-md whitespace-nowrap font-medium';
tooltipEl.style.cssText +=
  ';backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:opacity 0.12s ease, transform 0.12s ease;transform:translateY(-50%) translateX(-4px);';
document.body.appendChild(tooltipEl);

function isTruncated(el) {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

function positionTooltip(target) {
  const rect = target.getBoundingClientRect();
  const GAP = 14;

  tooltipEl.style.left = rect.right + GAP + 'px';
  tooltipEl.style.top = rect.top + rect.height / 2 + 'px';
  requestAnimationFrame(() => {
    const tipRect = tooltipEl.getBoundingClientRect();

    if (tipRect.right > window.innerWidth - 8) {
      tooltipEl.style.left = rect.left - tipRect.width - GAP + 'px';
    }
  });
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('[data-name]');

  if (!target || !isTruncated(target)) {
    tooltipEl.style.opacity = '0';
    tooltipEl.style.transform = 'translateY(-50%) translateX(-4px)';

    return;
  }

  tooltipEl.textContent = target.dataset.name;
  positionTooltip(target);
  tooltipEl.style.opacity = '1';
  tooltipEl.style.transform = 'translateY(-50%) translateX(0)';
});
document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-name]')) {
    tooltipEl.style.opacity = '0';
    tooltipEl.style.transform = 'translateY(-50%) translateX(-4px)';
  }
});

function showNotFound(path) {
  // A doc the viewer can't reach (filtered out of the tree) or that doesn't exist:
  // a clean in-app page instead of silently bouncing to the home. The wording is
  // deliberately ambiguous (not-found OR no-access) to keep the no-existence-oracle.
  currentFile = null;
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  // Reset the doc header/breadcrumb (path + mtime + actions) — else it would keep
  // revealing the path's existence and a "modified X ago" (an existence oracle).
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
    showWelcome();
  });
}

function routeFromHash() {
  // Route from the URL hash once fileMap reflects the viewer's accessible docs.
  const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  if (!hash || hash === 'mind') return showWelcome();
  const f = fileMap[hash];
  if (f && f.ext === '.md') return showMarkdown(f);
  if (f) return showWelcome();
  // Not in the (per-viewer filtered) tree. Only declare "not found / no access"
  // once the tree is actually loaded (server mode loads it async via softReload) —
  // before that, hold on the welcome to avoid a false flash.
  if (Object.keys(fileMap).length) showNotFound(hash);
  else showWelcome();
}

function showWelcome() {
  currentFile = null;
  // Reset width/padding overrides left by a previous .html render
  // (renderHtmlFrame), else the home page inherits full-width; restore the
  // todo widget hidden during the HTML preview.
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  const byCategory = {};
  let totalWords = 0;
  let longestDoc = null;

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;
    const parts = f.path.split('/');
    const cat = parts.length >= 2 ? parts[0] + (parts.length >= 3 ? '/' + parts[1] : '') : 'root';

    byCategory[cat] = (byCategory[cat] || 0) + 1;

    if (f.words) {
      totalWords += f.words;

      if (!longestDoc || f.words > longestDoc.words) longestDoc = { file: f, words: f.words };
    }
  }

  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const recent = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && f.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 4);
  const todoSummary = todos.length ? `${todos.filter((t) => t.done).length}/${todos.length}` : '–';

  const HEATMAP_WEEKS = 53;
  const dayMs = 86400 * 1000;
  const now = new Date();

  now.setHours(0, 0, 0, 0);
  const todayDow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getTime() - todayDow * dayMs);
  const startDate = new Date(monday.getTime() - (HEATMAP_WEEKS - 1) * 7 * dayMs);
  const cells = Array.from({ length: HEATMAP_WEEKS * 7 }, () => 0);
  let weekModif = 0,
    prevWeekModif = 0;
  const startOfThisWeek = monday.getTime() / 1000;
  const startOfPrevWeek = (monday.getTime() - 7 * dayMs) / 1000;

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md' || !f.mtime) continue;
    const d = new Date(f.mtime * 1000);

    d.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((d.getTime() - startDate.getTime()) / dayMs);

    if (diffDays >= 0 && diffDays < HEATMAP_WEEKS * 7) {
      const week = Math.floor(diffDays / 7);
      const day = diffDays % 7;

      cells[week * 7 + day] += 1;
    }

    if (f.mtime >= startOfThisWeek) weekModif += 1;
    else if (f.mtime >= startOfPrevWeek) prevWeekModif += 1;
  }

  const maxCell = Math.max(1, ...cells);
  const heatmapCells = [];

  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const count = cells[w * 7 + d];
      const intensity = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCell) * 4));
      const cellDate = new Date(startDate.getTime() + (w * 7 + d) * dayMs);
      const color = [
        '#1a1820',
        'rgba(29,155,209,0.18)',
        'rgba(29,155,209,0.36)',
        'rgba(29,155,209,0.6)',
        '#1d9bd1',
      ][intensity];
      const dateStr = cellDate.toLocaleDateString(LANG, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      const tip = (count === 0 ? t('heatNone') : t('heatCount', count)) + ' · ' + dateStr;

      heatmapCells.push(
        '<div data-tip="' +
          tip +
          '" style="background:' +
          color +
          ';border-radius:2px;cursor:default;"></div>',
      );
    }
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
        f.path +
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
    .sort((a, b) => b.words - a.words)
    .slice(0, 6);
  const maxWords = longest.length ? longest[0].words : 1;
  const rankingHtml = longest.length
    ? longest
        .map((f, i) => {
          const pct = Math.max(4, Math.round((100 * f.words) / maxWords));

          return (
            '<a data-recent-path="' +
            f.path +
            '" class="block cursor-pointer group">' +
            '<div class="flex items-center gap-2">' +
            '<span class="text-ink-500 font-mono text-xs w-4 text-right">' +
            (i + 1) +
            '</span>' +
            '<span class="text-sm text-ink-200 group-hover:text-accent truncate flex-1">' +
            escapeHtml(f.name) +
            '</span>' +
            '<span class="text-[11px] text-ink-500 font-mono whitespace-nowrap">' +
            f.words.toLocaleString(LANG) +
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
  const tagCounts = {};

  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;

    for (const t of f.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }

  const tagEntries = Object.entries(tagCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const maxTagCount = tagEntries.length ? tagEntries[0][1] : 1;
  const tagCloud = tagEntries
    .map(([t, n]) => {
      const scale = (0.78 + 0.5 * (n / maxTagCount)).toFixed(2);

      return (
        '<button class="doc-tag" data-hometag="' +
        escapeHtml(t) +
        '" style="font-size:' +
        scale +
        'rem">#' +
        escapeHtml(t) +
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
  contentEl.querySelectorAll('[data-recent-path]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.recentPath];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    });
  });
  contentEl.querySelectorAll('[data-hometag]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      showTag(b.dataset.hometag);
    }),
  );
  const homeGraphBtn = contentEl.querySelector('#home-graph-btn');

  if (homeGraphBtn) homeGraphBtn.addEventListener('click', openGraph);
  if (window.mountActivity) window.mountActivity();
  const hm = contentEl.querySelector('#home-heatmap');

  if (hm) {
    let tip = document.getElementById('hm-tip');

    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'hm-tip';
      tip.style.cssText =
        'position:fixed;z-index:60;pointer-events:none;opacity:0;transition:opacity .1s;background:#1a1d29;border:1px solid #2a2c36;color:#e5e7eb;font:500 11px system-ui,sans-serif;padding:4px 8px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.45);white-space:nowrap;';
      document.body.appendChild(tip);
    }

    hm.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('[data-tip]');

      if (cell) {
        tip.textContent = cell.dataset.tip;
        tip.style.opacity = '1';
      } else {
        tip.style.opacity = '0';
      }
    });
    hm.addEventListener('mousemove', (e) => {
      tip.style.left = e.clientX + 12 + 'px';
      tip.style.top = e.clientY - 34 + 'px';
    });
    hm.addEventListener('mouseleave', () => {
      tip.style.opacity = '0';
    });
  }

  breadcrumbPath.textContent = '/';
  breadcrumbDate.textContent = '';
  breadcrumbActions.classList.add('hidden');
  breadcrumbActions.classList.remove('flex');
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
}

// Sidebar + TOC collapse
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarShowInline = document.getElementById('sidebar-show-inline');
const tocClose = document.getElementById('toc-close');
const tocShow = document.getElementById('toc-show');

let sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
let tocHiddenMap = {};

try {
  tocHiddenMap = JSON.parse(localStorage.getItem('toc-hidden-per-doc') || '{}');
} catch (e) {}

const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

function applySidebar() {
  if (isMobile()) {
    sidebarEl.style.marginLeft = '';
    sidebarShowInline.classList.remove('hidden');

    return;
  }

  if (sidebarCollapsed) {
    sidebarEl.style.marginLeft = '-20rem';
    sidebarShowInline.classList.remove('hidden');
  } else {
    sidebarEl.style.marginLeft = '';
    sidebarShowInline.classList.add('hidden');
  }
}

function toggleSidebar() {
  if (isMobile()) {
    document.body.classList.toggle('sidebar-open');

    return;
  }

  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  applySidebar();
}

const sidebarBackdrop = document.getElementById('sidebar-backdrop');

sidebarBackdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
treeEl.addEventListener('click', (e) => {
  if (isMobile() && e.target.closest('a[data-path]'))
    document.body.classList.remove('sidebar-open');
});
window.addEventListener('resize', () => {
  if (!isMobile()) document.body.classList.remove('sidebar-open');
  applySidebar();
  applyToc();
});

function isTocHiddenForCurrent() {
  if (!currentFile) return false;

  return tocHiddenMap[currentFile.path] === true;
}

function applyToc() {
  if (!currentFile) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.add('hidden');

    return;
  }

  const hasContent = tocList.children.length >= 2 || tocHasLinks || tocHasNotes;

  if (isMobile()) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.toggle('hidden', !hasContent);

    return;
  }

  const hidden = isTocHiddenForCurrent();

  if (hidden || !hasContent) {
    tocPanel.classList.add('hidden');
    tocPanel.classList.remove('flex');
    tocShow.classList.toggle('hidden', !hasContent || !hidden);
  } else {
    tocPanel.classList.remove('hidden');
    tocPanel.classList.add('flex');
    tocShow.classList.add('hidden');
  }
}

function toggleToc() {
  if (!currentFile) return;

  if (isMobile()) {
    const wasHidden = tocPanel.classList.contains('hidden');

    tocPanel.classList.toggle('hidden', !wasHidden);
    tocPanel.classList.toggle('flex', wasHidden);
    tocShow.classList.toggle('hidden', wasHidden);

    return;
  }

  const path = currentFile.path;

  tocHiddenMap[path] = !isTocHiddenForCurrent();

  if (!tocHiddenMap[path]) delete tocHiddenMap[path];
  localStorage.setItem('toc-hidden-per-doc', JSON.stringify(tocHiddenMap));
  applyToc();
}

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarShowInline.addEventListener('click', toggleSidebar);
tocClose.addEventListener('click', toggleToc);
tocShow.addEventListener('click', toggleToc);
applySidebar();

document.getElementById('home-link').addEventListener('click', () => {
  showWelcome();
  history.replaceState(null, '', location.pathname);
});

// Download .md button
document.getElementById('btn-download').addEventListener('click', async () => {
  if (!currentFile) return;

  // Non-.md: download the ORIGINAL served as-is — loadContent would return text
  // and corrupt a binary .pdf/.docx.
  if (currentFile.ext !== '.md') {
    const fileUrl = '/' + currentFile.path.split('/').map(encodeURIComponent).join('/');
    const a = document.createElement('a');

    a.href = fileUrl;
    a.download = currentFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    return;
  }

  let content;

  try {
    content = await loadContent(currentFile);
  } catch (e) {
    alert(t('cantLoadDoc', e.message));

    return;
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = currentFile.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
});

// Command palette (Ctrl+K)
const paletteBackdrop = document.getElementById('palette-backdrop');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
const paletteCount = document.getElementById('palette-count');
let paletteItems = [];
let paletteIdx = 0;
let paletteNav = []; // actions + files matched by name/path (instant)
let paletteContent = []; // files matched by content (async, via getSearchHits)
let paletteSearchDebounce = null;
let paletteSearchSeq = 0;
