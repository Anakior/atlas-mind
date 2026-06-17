function mdHandleAction(action) {
  if (!editTextarea) return;
  editTextarea.focus();
  switch(action) {
    case 'bold': mdInsertWrap('**', '**', t('phText')); break;
    case 'italic': mdInsertWrap('*', '*', t('phText')); break;
    case 'strike': mdInsertWrap('~~', '~~', t('phText')); break;
    case 'h1': mdInsertLineStart('# '); break;
    case 'h2': mdInsertLineStart('## '); break;
    case 'h3': mdInsertLineStart('### '); break;
    case 'ul': mdInsertLineStart('- '); break;
    case 'ol': mdInsertLineStart('1. '); break;
    case 'todo': mdInsertLineStart('- [ ] '); break;
    case 'quote': mdInsertLineStart('> '); break;
    case 'link': mdInsertWrap('[', '](url)', t('phLabel')); break;
    case 'code': mdInsertWrap('`', '`', 'code'); break;
    case 'codeblock': mdInsertWrap('\n```\n', '\n```\n', 'code'); break;
    case 'hr': mdInsertAtCursor('\n\n---\n\n'); break;
    case 'table': mdInsertAtCursor('\n| Col 1 | Col 2 |\n| --- | --- |\n| A | B |\n'); break;
  }
}

const MD_TOOLBAR_HTML = '' +
  '<button data-md="bold" class="md-tb-btn" title="' + t('tbBold') + '"><b>B</b></button>' +
  '<button data-md="italic" class="md-tb-btn" title="' + t('tbItalic') + '"><i>I</i></button>' +
  '<button data-md="strike" class="md-tb-btn" title="' + t('tbStrike') + '"><s>S</s></button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="h1" class="md-tb-btn">H1</button>' +
  '<button data-md="h2" class="md-tb-btn">H2</button>' +
  '<button data-md="h3" class="md-tb-btn">H3</button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="ul" class="md-tb-btn" title="' + t('tbUl') + '">' + t('tbUlLabel') + '</button>' +
  '<button data-md="ol" class="md-tb-btn" title="' + t('tbOl') + '">' + t('tbOlLabel') + '</button>' +
  '<button data-md="todo" class="md-tb-btn" title="' + t('tbTodo') + '">☐ Todo</button>' +
  '<button data-md="quote" class="md-tb-btn" title="' + t('tbQuote') + '">' + t('tbQuoteLabel') + '</button>' +
  '<span class="md-tb-sep"></span>' +
  '<button data-md="link" class="md-tb-btn" title="' + t('tbLink') + '">' + t('tbLinkLabel') + '</button>' +
  '<button data-md="code" class="md-tb-btn" title="' + t('tbCode') + '">&lt;/&gt;</button>' +
  '<button data-md="codeblock" class="md-tb-btn" title="' + t('tbCodeblock') + '">' + t('tbCodeblockLabel') + '</button>' +
  '<button data-md="table" class="md-tb-btn" title="' + t('tbTable') + '">⊞ Table</button>' +
  '<button data-md="hr" class="md-tb-btn" title="' + t('tbHr') + '">— HR</button>';

// ─── [[wikilink]] autocomplete in the editor ──────────────────────────────────
// Triggered by typing `[[`: suggests docs (filtered by name/path), keyboard nav,
// inserts an always-resolvable target (name only if unique, full path otherwise).
// 100% client-side, relies on fileMap.
let wlOpen = false, wlItems = [], wlActive = 0, wlStart = -1, wlCands = null, wlMenuEl = null;
function wlMenu() {
  if (wlMenuEl) return wlMenuEl;
  wlMenuEl = document.createElement('div');
  wlMenuEl.id = 'wl-autocomplete';
  wlMenuEl.className = 'fixed z-50 hidden w-80 max-h-64 overflow-y-auto rounded-md border subtle-border bg-navy-800 shadow-xl scrollbar-thin text-sm';
  document.body.appendChild(wlMenuEl);
  wlMenuEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.wl-opt');
    if (!opt) return;
    e.preventDefault(); // keeps the textarea focus
    wlInsert(+opt.dataset.i);
  });
  document.addEventListener('mousedown', (e) => {
    if (wlOpen && !wlMenuEl.contains(e.target) && e.target !== editTextarea) wlClose();
  });
  return wlMenuEl;
}
function wlClose() {
  wlOpen = false; wlStart = -1; wlItems = [];
  if (wlMenuEl) { wlMenuEl.classList.add('hidden'); wlMenuEl.innerHTML = ''; }
}
function wlBuildCands() {
  const out = [];
  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    const stem = f.name.replace(/\.[^.]+$/, '');
    out.push({
      path: f.path, label: stem, sub: f.path, mtime: f.mtime || 0,
      _name: stem.toLowerCase(),
      _hay: (stem + ' ' + f.path).toLowerCase(),
    });
  }
  return out;
}
function wlQueryAtCursor() {
  const v = editTextarea.value, cur = editTextarea.selectionStart;
  const open = v.lastIndexOf('[[', cur - 2);
  if (open === -1 || open + 2 > cur) return null;
  const between = v.slice(open + 2, cur);
  if (/[\]\n]/.test(between)) return null;
  return { start: open, query: between };
}
function wlFilter(query) {
  if (!wlCands) wlCands = wlBuildCands();
  const q = query.trim().toLowerCase();
  let res;
  if (q) {
    res = wlCands.filter(c => c._hay.includes(q));
    const rank = (c) => c._name.startsWith(q) ? 0 : (c._name.includes(q) ? 1 : 2);
    res.sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime);
  } else {
    res = wlCands.slice().sort((a, b) => b.mtime - a.mtime);
  }
  return res.slice(0, 8);
}
function wlRender() {
  const m = wlMenu();
  m.innerHTML = wlItems.map((c, i) =>
    '<div class="wl-opt px-3 py-1.5 cursor-pointer ' + (i === wlActive ? 'bg-white/10' : '') + '" data-i="' + i + '">' +
      '<div class="text-ink-100 truncate">' + escapeHtml(c.label) + '</div>' +
      '<div class="text-[11px] text-ink-400 truncate">' + escapeHtml(c.sub) + '</div>' +
    '</div>').join('');
  m.classList.remove('hidden');
  if (m.children[wlActive]) m.children[wlActive].scrollIntoView({ block: 'nearest' });
}
function wlCaretCoords() {
  const ta = editTextarea, pos = ta.selectionStart, s = getComputedStyle(ta);
  const div = document.createElement('div');
  ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
   'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
   'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
   'textTransform', 'wordSpacing', 'textIndent', 'tabSize'].forEach(p => { div.style[p] = s[p]; });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.overflow = 'hidden';
  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = ta.value.slice(pos) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const lh = parseInt(s.lineHeight, 10) || parseInt(s.fontSize, 10) || 16;
  const rect = ta.getBoundingClientRect();
  const top = rect.top + span.offsetTop - ta.scrollTop + lh;
  const left = rect.left + span.offsetLeft - ta.scrollLeft;
  document.body.removeChild(div);
  return { top, left, lineHeight: lh };
}
function wlPosition() {
  const m = wlMenu();
  const c = wlCaretCoords();
  let top = c.top + 4, left = c.left;
  const mh = m.offsetHeight || 200, mw = m.offsetWidth || 320;
  if (top + mh > window.innerHeight - 8) top = c.top - c.lineHeight - mh - 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  m.style.top = Math.max(8, top) + 'px';
  m.style.left = Math.max(8, left) + 'px';
}
function wlTargetFor(path) {
  const stem = fileMap[path].name.replace(/\.[^.]+$/, '');
  const stemLc = stem.toLowerCase();
  let count = 0;
  for (const f of Object.values(fileMap)) {
    if (WL_TARGET_EXTS.includes(f.ext) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === stemLc) count++;
  }
  return count <= 1 ? stem : path.replace(/\.[^.]+$/, '');
}
function wlUpdate() {
  if (!editTextarea) return;
  const q = wlQueryAtCursor();
  if (!q) { wlClose(); return; }
  wlStart = q.start;
  wlItems = wlFilter(q.query);
  if (!wlItems.length) { wlClose(); return; }
  wlActive = 0; wlOpen = true;
  wlRender(); wlPosition();
}
function wlInsert(i) {
  const c = wlItems[i];
  if (!c || wlStart < 0) { wlClose(); return; }
  const cur = editTextarea.selectionStart;
  editTextarea.setRangeText('[[' + wlTargetFor(c.path) + ']]', wlStart, cur, 'end');
  wlClose();
  editTextarea.focus();
  editTextarea.dispatchEvent(new Event('input'));
}
function wlHandleKeydown(e) {
  if (!wlOpen) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); wlActive = (wlActive + 1) % wlItems.length; wlRender(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); wlActive = (wlActive - 1 + wlItems.length) % wlItems.length; wlRender(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); wlInsert(wlActive); return true; }
  if (e.key === 'Escape') { e.preventDefault(); wlClose(); return true; }
  return false;
}

async function enterEditMode() {
  if (!currentFile) return;
  // Make sure we have the content before switching to edit mode.
  let content;
  try { content = await loadContent(currentFile); }
  catch (e) { alert(t('cantLoadDoc', e.message)); return; }
  editMode = true;
  contentEl.classList.remove('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
  contentEl.classList.add('max-w-none', 'px-4', 'py-4');

  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col';
  wrap.style.height = 'calc(100vh - 11rem)';

  const toolbar = document.createElement('div');
  toolbar.className = 'flex flex-wrap items-center gap-1 px-3 py-2 border subtle-border rounded-t-md bg-navy-800';
  toolbar.innerHTML = MD_TOOLBAR_HTML;

  const splitWrap = document.createElement('div');
  splitWrap.className = 'flex flex-1 min-h-0 border-l border-r border-b subtle-border rounded-b-md overflow-hidden bg-navy-900';

  editTextarea = document.createElement('textarea');
  editTextarea.id = 'md-editor';
  editTextarea.value = content;
  editTextarea.spellcheck = false;
  editTextarea.className = 'min-w-0 p-5 bg-transparent text-ink-100 resize-none focus:outline-none scrollbar-thin';
  editTextarea.style.flex = '1 1 0';

  const divider = document.createElement('div');
  divider.className = 'w-px bg-[#2a2a32] flex-shrink-0';

  const preview = document.createElement('article');
  preview.id = 'md-preview';
  preview.className = 'min-w-0 px-8 py-6 overflow-y-auto scrollbar-thin prose prose-sm prose-invert max-w-none';
  preview.style.flex = '1 1 0';
  preview.innerHTML = renderMd(content);

  splitWrap.appendChild(editTextarea);
  splitWrap.appendChild(divider);
  splitWrap.appendChild(preview);

  wrap.appendChild(toolbar);
  wrap.appendChild(splitWrap);

  contentEl.innerHTML = '';
  contentEl.appendChild(wrap);

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md]');
    if (btn) mdHandleAction(btn.dataset.md);
  });

  wlCands = null; // recomputed on the 1st keystroke (catches any new docs)
  let previewTimer = null;
  editTextarea.addEventListener('input', () => {
    wlUpdate();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      preview.innerHTML = renderMd(editTextarea.value);
    }, 150);
  });
  editTextarea.addEventListener('blur', () => setTimeout(wlClose, 150));
  editTextarea.addEventListener('keydown', (e) => {
    if (wlHandleKeydown(e)) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); mdHandleAction('bold'); return; }
      if (k === 'i') { e.preventDefault(); mdHandleAction('italic'); return; }
      if (k === 'l') { e.preventDefault(); mdHandleAction('link'); return; }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      mdInsertAtCursor('  ');
    }
  });

  editTextarea.focus();
  editTextarea.setSelectionRange(0, 0);
  editTextarea.scrollTop = 0;

  btnEdit.classList.add('hidden');
  btnSave.classList.remove('hidden');
  btnCancel.classList.remove('hidden');
  // Extensions hook: entering edit mode (hide their doc actions).
  document.dispatchEvent(new CustomEvent('atlas:edit-enter'));
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');
  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
}

async function saveEdit() {
  if (!editMode || !currentFile) return;
  if (!isServerMode) { alert(t('fileModeNoEdit')); return; }
  const newContent = editTextarea.value;
  btnSave.disabled = true; btnSave.textContent = t('saving');
  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentFile.path, content: newContent })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    currentFile.content = newContent;
    contentCache.set(currentFile.path, newContent);
    currentFile.mtime = data.mtime || Math.floor(Date.now() / 1000);
    // Neutralize the live-reload SSE that follows the commit, to avoid a 2nd
    // re-render (flash) on top of the one done when exiting edit mode. Same trick
    // as the checkboxes.
    _selfSaveUntil[currentFile.path] = Date.now() + 6000;
    exitEditMode(true);
  } catch (e) {
    alert(t('err', e.message));
  } finally {
    btnSave.disabled = false; btnSave.textContent = t('saveBtn');
  }
}

function exitEditMode(reload) {
  wlClose();
  editMode = false;
  editTextarea = null;
  contentEl.classList.add('max-w-4xl', 'px-10', 'py-10', 'prose', 'prose-invert');
  contentEl.classList.remove('max-w-none', 'px-4', 'py-4');
  if (reload && currentFile) showMarkdown(currentFile);
  else if (currentFile) {
    btnEdit.classList.remove('hidden');
    btnSave.classList.add('hidden');
    btnCancel.classList.add('hidden');
    // Re-render from the cached content (always present since we were editing).
    const cached = currentFile.content != null ? currentFile.content : contentCache.get(currentFile.path);
    contentEl.innerHTML = renderMd(cached || '');
    attachCopyButtons();
    wireTaskCheckboxes(currentFile, cached || '');
    renderBacklinksFor(currentFile);
    buildToc();
    document.dispatchEvent(new CustomEvent('atlas:doc-rendered', { detail: { path: currentFile.path, markdown: cached || '' } }));
  }
}

btnEdit.addEventListener('click', enterEditMode);
btnSave.addEventListener('click', saveEdit);
btnCancel.addEventListener('click', () => exitEditMode(false));

// ─── Search (MiniSearch, lazy-loaded on first call) ───────────────────────────────
let miniSearch = null;
let searchInitPromise = null;
const SEARCH_FIELDS = ['name', 'path', 'content'];
const SEARCH_STORE = ['name', 'path', 'preview'];

// Local lib (/vendor/); in an offline build (file://) it's inlined into the
// monolith by build.py, so the typeof short-circuits — no fetch.
async function loadMiniSearchLib() {
  if (typeof MiniSearch !== 'undefined') return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/minisearch.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error(t('cdnFailMiniSearch')));
    document.head.appendChild(s);
  });
}

// MiniSearch is only used in offline builds (file://, no server). Online,
// search goes through /api/search. We index the already-embedded content.
async function getSearchData() {
  const docs = [];
  for (const f of Object.values(fileMap)) {
    if (f.ext !== '.md') continue;
    const c = EMBED_CONTENT[f.path] || '';
    docs.push({ id: f.path, name: f.name, path: f.path, content: c, preview: c.slice(0, 240) });
  }
  return docs;
}

async function initMiniSearch() {
  if (miniSearch) return miniSearch;
  if (searchInitPromise) return searchInitPromise;
  searchInitPromise = (async () => {
    await loadMiniSearchLib();
    const docs = await getSearchData();
    const ms = new MiniSearch({
      idField: 'id',
      fields: SEARCH_FIELDS,
      storeFields: SEARCH_STORE,
      searchOptions: {
        boost: { name: 3, path: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'AND',
      },
      tokenize: (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
      processTerm: (term) => term.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    });
    ms.addAll(docs);
    miniSearch = ms;
    return ms;
  })();
  return searchInitPromise;
}

function makeSnippet(preview, query) {
  if (!preview) return '';
  const words = query.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  const lower = preview.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let idx = -1, term = null;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (idx < 0 || i < idx)) { idx = i; term = w; }
  }
  if (idx < 0) return preview.slice(0, 160) + (preview.length > 160 ? '…' : '');
  const start = Math.max(0, idx - 40);
  const end = Math.min(preview.length, idx + term.length + 80);
  return (start > 0 ? '…' : '') + preview.slice(start, end) + (end < preview.length ? '…' : '');
}

// Online: server-side search (/api/search) → transfer O(results), nothing to
// download. Offline (file:// monolith): MiniSearch over the embedded content.
// Each branch returns a normalized array [{path, snippet}].
async function getSearchHits(q) {
  if (IS_OFFLINE_BUILD) {
    const ms = await initMiniSearch();
    const matches = ms.search(q, { boost: { name: 3, path: 2 }, fuzzy: 0.2, prefix: true });
    return matches.map(m => ({ path: m.path, snippet: makeSnippet(m.preview || '', q) }));
  }
  const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=50', { cache: 'no-store' });
  if (!res.ok) throw new Error('search HTTP ' + res.status);
  const hits = await res.json();
  return hits.map(h => ({ path: h.path, snippet: h.snippet || '' }));
}

async function renderSearchResults(q) {
  searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-ink-500">' + t('searching') + '</div>';
  let hits;
  try { hits = await getSearchHits(q); }
  catch (e) {
    searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-rose-400">' + escapeHtml(t('err', e.message)) + '</div>';
    return;
  }
  if (searchEl.value.trim() !== q) return; // user typed something else in the meantime
  if (hits.length === 0) {
    searchResultsEl.innerHTML = '<div class="px-3 py-4 text-xs text-ink-500">' + escapeHtml(t('noResults', q)) + '</div>';
    return;
  }
  const top = hits.slice(0, 50);
  searchResultsEl.innerHTML = '<div class="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">' + t('nResults', hits.length) + (hits.length > 50 ? t('cappedSuffix') : '') + '</div>';
  const tokens = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).filter(Boolean);
  const highlightRe = tokens.length ? new RegExp('(' + tokens.join('|') + ')', 'gi') : null;
  for (const m of top) {
    const file = fileMap[m.path];
    if (!file) continue;
    const a = document.createElement('a');
    a.className = 'tree-item block px-2 py-1.5 rounded cursor-pointer text-ink-200 mb-0.5';
    a.dataset.path = file.path;
    const snippet = m.snippet;
    const snippetHtml = snippet && highlightRe
      ? '<div class="text-[11px] text-ink-400 mt-0.5 leading-snug">' + escapeHtml(snippet).replace(highlightRe, '<mark class="bg-blue-500/30 text-blue-200 rounded px-0.5">$1</mark>') + '</div>'
      : '';
    a.innerHTML = '<div class="text-sm font-medium text-ink-100 truncate">' + escapeHtml(file.name) + '</div><div class="text-[10px] text-ink-500">' + file.path + '</div>' + snippetHtml;
    if (file.ext === '.md' || file.ext === '.html') {
      a.addEventListener('click', (e) => { e.preventDefault(); showMarkdown(file, q); });
    } else {
      a.href = encodeURI(file.path);
    }
    searchResultsEl.appendChild(a);
  }
}

let searchDebounce = null;
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim();
  clearTimeout(searchDebounce);
  if (!q) {
    searchResultsEl.classList.add('hidden');
    treeEl.classList.remove('hidden');
    if (recentList.children.length > 0) recentSection.classList.remove('hidden');
    return;
  }
  treeEl.classList.add('hidden');
  recentSection.classList.add('hidden');
  searchResultsEl.classList.remove('hidden');
  searchDebounce = setTimeout(() => renderSearchResults(q), 140);
});

// Recent files (top 5 most recent .md)
