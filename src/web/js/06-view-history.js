function renderSkeleton(file) {
  // Variable but deterministic layout: same doc → same skeleton (visual
  // consistency on refresh), different docs → different layouts (less
  // "Windows OS wallpaper"). Simple LCG over the hash of the path.
  let state = (file && file.path ? hashStr(file.path) : 1) || 1;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0);
  const range = (min, max) => min + (next() % (max - min + 1));
  const coin = (p) => next() % 100 < p * 100;

  const parts = [];
  const para = (lines) => {
    const rows = [];

    for (let i = 0; i < lines; i++) {
      const isLast = i === lines - 1;
      const isPenult = i === lines - 2;
      let w;

      if (isLast) w = range(35, 70);
      else if (isPenult && coin(0.4)) w = range(78, 94);
      else w = range(95, 100);
      rows.push('<div class="skeleton" style="height:.95rem;width:' + w + '%;"></div>');
    }

    return (
      '<div style="display:flex;flex-direction:column;gap:.55rem;margin-bottom:1.75rem;">' +
      rows.join('') +
      '</div>'
    );
  };

  const h2 = () =>
    '<div class="skeleton-h2" style="height:1.6rem;width:' +
    range(28, 58) +
    '%;margin-bottom:1rem;margin-top:.5rem;"></div>';
  const code = () =>
    '<div class="skeleton-code" style="height:' +
    range(4, 9) +
    'rem;margin-bottom:1.75rem;"></div>';

  // Title + meta (always present)
  parts.push(
    '<div class="skeleton-title" style="height:2.4rem;width:' +
      range(48, 78) +
      '%;margin-bottom:1rem;"></div>',
  );
  parts.push(
    '<div style="display:flex;gap:.5rem;margin-bottom:2rem;">' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(5, 9) +
      'rem;"></div>' +
      '<div class="skeleton" style="height:.7rem;width:' +
      range(4, 7) +
      'rem;"></div>' +
      '</div>',
  );

  // First paragraph (always)
  parts.push(para(range(3, 5)));

  // 1 to 3 sections (h2 + paragraph, sometimes a code block)
  const sections = range(1, 3);

  for (let s = 0; s < sections; s++) {
    parts.push(h2());
    parts.push(para(range(2, 5)));

    if (coin(0.4)) parts.push(code());
  }

  return (
    '<div class="not-prose" aria-busy="true" aria-label="' +
    t('loadingDoc') +
    '">' +
    parts.join('') +
    '</div>'
  );
}

function hashStr(s) {
  // djb2 — small stable fingerprint to seed the skeleton's LCG
  let h = 5381;

  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;

  return h;
}

async function showMarkdown(file, highlightQuery) {
  if (editMode) exitEditMode(false);
  currentFile = file;
  // Reset the overrides set by HTML rendering (cf. renderHtmlFrame): a .md doc
  // after a .html must get back the prose width/padding, and the todos widget
  // (hidden during the HTML preview) must reappear.
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  document.getElementById('todo-widget')?.classList.remove('hidden');
  contentEl.innerHTML = renderSkeleton(file);
  // Breadcrumb: we replace the technical prefix « remotes/ » with the label
  // « Mental nodes / » (consistent with the tree).
  breadcrumbPath.textContent = file.path.startsWith('remotes/')
    ? t('remotesLabel') + ' / ' + file.path.slice('remotes/'.length)
    : file.path;
  const parts = [];

  if (file.mtime) parts.push(t('modifiedAgo', relativeDate(file.mtime)));
  const rt = readingTimeFromWords(file.words);

  if (rt) parts.push(t('readingTime', rt.minutes, rt.words.toLocaleString(LANG)));
  breadcrumbDate.textContent = parts.length ? '· ' + parts.join(' · ') : '';
  breadcrumbActions.classList.remove('hidden');
  breadcrumbActions.classList.add('flex');
  // Mirror doc (under remotes/) = read-only mental node of another atlas: no Edit
  // (write → 403), no Share (don't re-share others' content), no ⋯ menu
  // (rename/move/delete → 403).
  const isRemoteDoc = (file.path || '').startsWith('remotes/');

  btnEdit.classList.toggle('hidden', isRemoteDoc);
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  document.getElementById('btn-share')?.classList.toggle('hidden', isRemoteDoc);
  document.getElementById('btn-access')?.classList.toggle('hidden', isRemoteDoc || IS_OFFLINE_BUILD);
  document.getElementById('btn-more-wrap')?.classList.toggle('hidden', isRemoteDoc);
  // Remote node actions: only on a mirror doc, never offline (no server to
  // appropriate/remove against — the buttons would 404).
  const showNodeActions = isRemoteDoc && !IS_OFFLINE_BUILD;

  document.getElementById('btn-node-appropriate')?.classList.toggle('hidden', !showNodeActions);
  document.getElementById('btn-node-remove')?.classList.toggle('hidden', !showNodeActions);
  // Download button label = the doc's actual extension (.md/.html/.pdf/.docx).
  const dlExt = document.getElementById('btn-download-ext');

  if (dlExt) dlExt.textContent = file.ext || '';
  // Close any history panel left open from the previous doc so it never shows
  // stale revisions; the button itself is gated by historyAvailable().
  closeHistory();
  document.getElementById('btn-history')?.classList.toggle('hidden', !historyAvailable(file));
  updatePinButton(file);
  document.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
  const active = document.querySelector(`[data-path="${file.path}"]`);

  if (active) {
    active.classList.add('active');
    let p = active.parentElement;

    while (p && p !== treeEl) {
      if (p.tagName === 'UL' && p.classList.contains('hidden')) {
        p.classList.remove('hidden');
        const btn = p.previousElementSibling;

        if (btn) btn.querySelector('.caret')?.classList.add('open');
      }

      p = p.parentElement;
    }
  }

  document.querySelector('main').scrollTop = 0;

  // .html document → standalone render in an isolated iframe, no markdown pipeline.
  if (file.ext === '.html') {
    renderHtmlFrame(file);

    return;
  }

  // .pdf document → browser's native viewer in an iframe, no markdown.
  if (file.ext === '.pdf') {
    renderPdfFrame(file);

    return;
  }

  // Word document → converted to readable HTML in the browser (read-only).
  if (file.ext === '.docx') {
    renderDocxFrame(file);

    return;
  }

  let content;

  try {
    content = await loadContent(file);
  } catch (e) {
    if (currentFile !== file) return;
    contentEl.innerHTML =
      '<div class="text-rose-400 text-sm">' + escapeHtml(t('loadError', e.message)) + '</div>';

    return;
  }

  if (currentFile !== file) return;
  const body = stripFrontmatter(content);

  contentEl.innerHTML = renderDocTags(file) + renderMd(body);
  attachCopyButtons();
  wireTaskCheckboxes(file, content);
  renderBacklinksFor(file);
  buildToc();
  renderNotesFor(file);
  // Extensions hook: the doc has just been rendered (path + markdown without
  // frontmatter). Extensions listen to decorate / track the current doc.
  document.dispatchEvent(
    new CustomEvent('atlas:doc-rendered', { detail: { path: file.path, markdown: body } }),
  );

  if (highlightQuery) highlightFirstMatch(contentEl, highlightQuery);
}

// ─── Git history (revisions + diff) ──────────────────────────────────────────
// Each doc is versioned git. This panel lists a doc's revisions and shows, per
// revision, what that commit changed (diff against the previous revision) or the
// full version at that point. Backed by /api/history|diff|revision, which require
// an authenticated admin/viewer — so the button is hidden in offline builds and
// read-only share views, where those endpoints don't exist / return 401.
const historyOverlay = document.getElementById('history-overlay');
const historyList = document.getElementById('history-list');
const historyDetail = document.getElementById('history-detail');
const historyPathEl = document.getElementById('history-path');
let historyFile = null;

function historyAvailable(file) {
  // Inline the protocol check rather than reference the `isServerMode` const:
  // showMarkdown calls this synchronously before its first await, so on an initial
  // deep-link it can run before that const is initialized (TDZ).
  const serverMode = location.protocol === 'http:' || location.protocol === 'https:';

  return (
    !!file &&
    (file.ext === '.md' || file.ext === '.html') &&
    serverMode &&
    !IS_OFFLINE_BUILD &&
    !window.__viewerMode &&
    !(file.path || '').startsWith('remotes/')
  );
}

function closeHistory() {
  historyFile = null;
  historyOverlay.classList.add('hidden');
}

function formatRevDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);

  return isNaN(d)
    ? ''
    : d.toLocaleDateString(LANG, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function openHistory() {
  const file = currentFile;

  if (!historyAvailable(file)) return;
  historyFile = file;
  historyPathEl.textContent = file.path;
  historyList.innerHTML = '<div class="text-ink-500 px-2 py-1">…</div>';
  historyDetail.innerHTML = '<div class="text-ink-500">' + escapeHtml(t('historyPick')) + '</div>';
  historyOverlay.classList.remove('hidden');
  let data;

  try {
    data = await api('GET', '/api/history?path=' + encodeURIComponent(file.path));
  } catch (e) {
    if (historyFile !== file) return;
    historyList.innerHTML =
      '<div class="text-rose-400 px-2 py-1">' + escapeHtml(t('historyError')) + '</div>';

    return;
  }

  if (historyFile !== file) return; // user closed / navigated mid-load
  const revisions = data.revisions || [];

  if (!revisions.length) {
    historyList.innerHTML =
      '<div class="text-ink-500 px-2 py-1">' + escapeHtml(t('historyEmpty')) + '</div>';

    return;
  }

  historyList.innerHTML = '';
  revisions.forEach((rev, i) => {
    const when = formatRevDate(rev.date);
    const row = document.createElement('button');

    row.type = 'button';
    row.className =
      'block w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 mb-0.5 transition';
    row.innerHTML =
      '<div class="text-ink-200 truncate">' +
      escapeHtml(rev.subject || '(' + rev.sha.slice(0, 7) + ')') +
      '</div>' +
      '<div class="text-xs text-ink-500 font-mono mt-0.5">' +
      escapeHtml(rev.sha.slice(0, 7)) +
      (when ? ' · ' + escapeHtml(when) : '') +
      (rev.author ? ' · ' + escapeHtml(rev.author) : '') +
      '</div>';
    row.addEventListener('click', () => {
      historyList.querySelectorAll('button').forEach((b) => b.classList.remove('bg-accent/15'));
      row.classList.add('bg-accent/15');
      showVersion(file, revisions, i);
    });
    historyList.appendChild(row);
  });
  historyList.querySelector('button')?.click(); // open the latest revision by default
}

// `toggle` = { label, handler } for the secondary button: document view ↔ diff
// view. The document is the default (cf. row click).
function revisionHeader(file, revisions, i, toggle) {
  const rev = revisions[i];
  const wrap = document.createElement('div');

  wrap.className = 'mb-3 pb-2 border-b subtle-border';
  const when = rev.date ? new Date(rev.date).toLocaleString(LANG) : '';

  wrap.innerHTML =
    '<div class="text-ink-100 font-medium">' +
    escapeHtml(rev.subject || '') +
    '</div>' +
    '<div class="text-xs text-ink-500 font-mono mt-0.5">' +
    escapeHtml(rev.sha.slice(0, 7)) +
    (when ? ' · ' + escapeHtml(when) : '') +
    (rev.author ? ' · ' + escapeHtml(rev.author) : '') +
    '</div>';
  // Actions in a flex-wrap row (gap, no per-button margin): stay left-aligned
  // whether they sit on one line (desktop) or wrap to two (mobile) — the old
  // marginLeft hack left the wrapped button indented by 8px.
  const actions = document.createElement('div');

  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px';
  const view = document.createElement('button');

  view.type = 'button';
  view.className =
    'px-3 py-1.5 text-sm font-medium bg-white/5 hover:bg-white/10 text-ink-200 rounded-lg transition';
  view.textContent = t(toggle.label);
  view.addEventListener('click', toggle.handler);
  actions.appendChild(view);
  const restore = document.createElement('button');

  restore.type = 'button';
  restore.className =
    'px-3 py-1.5 text-sm font-medium bg-accent/15 hover:bg-accent/25 text-accent rounded-lg transition';
  restore.textContent = t('historyRestore');
  restore.addEventListener('click', () => revertToRevision(file, rev));
  actions.appendChild(restore);
  wrap.appendChild(actions);

  return wrap;
}

async function showRevision(file, revisions, i) {
  const rev = revisions[i];
  const parent = revisions[i + 1]; // newest-first → the next entry is the older revision

  historyDetail.innerHTML = '';
  historyDetail.appendChild(
    revisionHeader(file, revisions, i, {
      label: 'historyViewVersion',
      handler: () => showVersion(file, revisions, i),
    }),
  );
  const body = document.createElement('div');

  body.className = 'text-ink-500';
  body.textContent = '…';
  historyDetail.appendChild(body);

  try {
    if (parent) {
      const data = await api(
        'GET',
        '/api/diff?path=' +
          encodeURIComponent(file.path) +
          '&from=' +
          parent.sha +
          '&to=' +
          rev.sha,
      );

      if (historyFile !== file) return;
      body.replaceWith(
        data.diff && data.diff.trim() ? diffToDom(data.diff) : simpleNode(t('historyNoChange')),
      );
    } else {
      // Oldest revision: no parent to diff against → show the full version as introduced.
      const data = await api(
        'GET',
        '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
      );

      if (historyFile !== file) return;
      body.replaceWith(plainTextNode(data.content));
    }
  } catch (e) {
    if (historyFile !== file) return;
    body.textContent = t('historyError');
    body.className = 'text-rose-400';
  }
}

// Default view when a revision is picked: the DOCUMENT at that revision (what the
// reader cares about first), with a button to switch to the git diff.
async function showVersion(file, revisions, i) {
  const rev = revisions[i];

  historyDetail.innerHTML = '';
  historyDetail.appendChild(
    revisionHeader(file, revisions, i, {
      label: 'historyViewChanges',
      handler: () => showRevision(file, revisions, i),
    }),
  );
  const wrap = document.createElement('div');

  // max-w-none: let the rendered version fill the (now wide) detail pane instead
  // of the default ~65ch prose cap, so md uses the room on large screens.
  wrap.className = 'prose prose-invert max-w-none text-base mt-1';
  wrap.innerHTML = '<p class="text-ink-500">…</p>';
  historyDetail.appendChild(wrap);
  let data;

  try {
    data = await api(
      'GET',
      '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
    );
  } catch (e) {
    if (historyFile !== file) return;
    wrap.innerHTML = '<p class="text-rose-400">' + escapeHtml(t('historyError')) + '</p>';

    return;
  }

  if (historyFile !== file) return;

  // .html doc: render the past version as-is in a sandboxed iframe (no markdown
  // pipeline), mirroring the live render (cf. renderHtmlFrame). srcdoc set as a
  // property so the raw HTML is never concatenated into the viewer DOM; its JS
  // runs in an opaque origin (allow-scripts, no same-origin) with no access to
  // the viewer's cookies/DOM.
  if (file.ext === '.html') {
    const frame = document.createElement('iframe');

    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = file.name;
    frame.srcdoc = data.content || '';
    frame.style.cssText =
      'width:100%;height:60vh;border:0;display:block;background:#0b0d13;border-radius:.5rem';
    wrap.replaceWith(frame);

    return;
  }

  wrap.innerHTML = renderMd(stripFrontmatter(data.content || '')); // sanitized via DOMPurify
}

// Restore a doc to a past revision by writing that content back as a new,
// forward-moving change (kept in git history). Admin-only server-side; CSRF is
// auto-injected by the global fetch wrapper.
async function revertToRevision(file, rev) {
  const ok = await confirmDialog({
    title: t('historyRestore'),
    message: t('historyRestoreConfirm'),
    confirmLabel: t('historyRestoreBtn'),
  });

  if (!ok) return;

  try {
    await api('POST', '/api/revert', { path: file.path, rev: rev.sha });
  } catch (e) {
    setStatus(t('historyRestoreError'), 'err');

    return;
  }

  contentCache.delete(file.path); // force a fresh load of the restored content
  closeHistory();
  setStatus(t('historyRestored'), 'info');
  showMarkdown(file);
}

function simpleNode(text) {
  const d = document.createElement('div');

  d.className = 'text-ink-500';
  d.textContent = text;

  return d;
}

function plainTextNode(text) {
  const pre = document.createElement('pre');

  pre.className = 'font-mono text-[15px] leading-relaxed text-ink-300';
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  pre.textContent = text || '';

  return pre;
}

// Unified diff → escaped, color-coded DOM. Diff colors use inline styles because
// the green/emerald utilities aren't in the precompiled tailwind.css.
function diffToDom(diffText) {
  const wrap = document.createElement('div');

  wrap.className = 'font-mono text-[15px] leading-relaxed';
  wrap.style.whiteSpace = 'pre-wrap';
  wrap.style.wordBreak = 'break-word';
  // Skip everything before the first @@ (git plumbing: diff --git / index / --- /
  // +++, noise for a reader). Each @@ → a thin separator. After the first @@ every
  // line is content, so a content line starting with --- is rendered, not skipped.
  let hunks = 0;

  for (const line of (diffText || '').split('\n')) {
    if (line.startsWith('@@')) {
      if (hunks > 0) {
        const sep = document.createElement('div');

        sep.className = 'border-t subtle-border';
        sep.style.margin = '8px 0';
        wrap.appendChild(sep);
      }

      hunks++;
      continue;
    }

    if (hunks === 0) continue;
    const row = document.createElement('div');

    row.className = 'px-2';

    if (line[0] === '+') {
      row.style.color = '#86efac';
      row.style.background = 'rgba(16,185,129,0.10)';
    } else if (line[0] === '-') {
      row.style.color = '#fca5a5';
      row.style.background = 'rgba(244,63,94,0.10)';
    } else {
      row.className += ' text-ink-400';
    }

    row.textContent = line === '' ? ' ' : line;
    wrap.appendChild(row);
  }

  return wrap;
}

document.getElementById('btn-history').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistory();
});

// Render a .html doc (slide deck, dashboard…) as-is in a sandboxed iframe.
// sandbox="allow-scripts" runs its JS but isolates it in an opaque origin (no
// access to the viewer's DOM/cookies); allow="fullscreen" enables fullscreen.
// The raw HTML is never injected into the viewer's DOM.
