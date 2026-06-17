function stripFrontmatter(text) {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

function folderTagsOf(path) {
  return path
    .split('/')
    .slice(0, -1)
    .map((s) => s.toLowerCase());
}

// Clickable tag chips for the doc (→ view by tag).
function renderDocTags(file) {
  if (!file || file.ext !== '.md') return '';
  // Mirror doc = read-only: no +/× (any tag write would 403).
  const canEdit =
    !IS_OFFLINE_BUILD && !window.__viewerMode && !(file.path || '').startsWith('remotes/');
  const folderSet = new Set(folderTagsOf(file.path));
  const chips = (file.tags || [])
    .map((tg) =>
      folderSet.has(tg)
        ? '<span class="doc-tag doc-tag-folder" data-tag="' +
          escapeHtml(tg) +
          '" title="' +
          escapeHtml(t('folderTagTitle')) +
          '">#' +
          escapeHtml(tg) +
          '</span>'
        : '<span class="doc-tag" data-tag="' +
          escapeHtml(tg) +
          '">#' +
          escapeHtml(tg) +
          (canEdit
            ? '<button class="doc-tag-x" data-removetag="' +
              escapeHtml(tg) +
              '" title="' +
              escapeHtml(t('removeTag')) +
              '">×</button>'
            : '') +
          '</span>',
    )
    .join('');

  if (!chips && !canEdit) return '';

  return (
    '<div class="doc-tags not-prose">' +
    chips +
    (canEdit
      ? '<button class="doc-tag-add" title="' + escapeHtml(t('addTag')) + '">+</button>'
      : '') +
    '</div>'
  );
}

function allTagsList() {
  const s = new Set();

  for (const f of Object.values(fileMap))
    if (f.ext === '.md') for (const t of f.tags || []) s.add(t);

  return [...s].sort();
}

// Rewrites the `tags:` frontmatter key (custom tags only — folder tags are derived
// at build). Empty list → removes the key (and the frontmatter block if it empties).
function setFrontmatterTags(content, customTags) {
  const tagsLine = customTags.length ? 'tags: [' + customTags.join(', ') + ']' : null;
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);

  if (m) {
    const lines = m[1].split(/\r?\n/);
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      if (/^tags[ \t]*:/i.test(lines[i])) {
        let j = i + 1;

        while (j < lines.length && /^[ \t]*-[ \t]+/.test(lines[j])) j++;
        i = j - 1;
        continue;
      }

      out.push(lines[i]);
    }

    if (tagsLine) out.push(tagsLine);
    const cleaned = out.filter((l) => l.trim().length).join('\n');
    const body = content.slice(m[0].length).replace(/^\n+/, '');

    return cleaned ? '---\n' + cleaned + '\n---\n\n' + body : body;
  }

  return tagsLine ? '---\n' + tagsLine + '\n---\n\n' + content : content;
}

// Persists custom tags: rewrite frontmatter, PUT /api/file (server rebuilds +
// commits), then update fileMap and re-render the chips locally.
async function persistTags(file, customTags) {
  let raw;

  try {
    raw = await loadContent(file);
  } catch (e) {
    return false;
  }

  const newContent = setFrontmatterTags(raw, customTags);

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: file.path, content: newContent }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    alert(t('tagSaveFailed', err.message));

    return false;
  }

  contentCache.set(file.path, newContent);
  file.content = newContent;
  const merged = folderTagsOf(file.path);

  for (const t of customTags) if (!merged.includes(t)) merged.push(t);
  file.tags = merged;

  if (currentFile === file) {
    const wrap = contentEl.querySelector('.doc-tags');

    if (wrap) wrap.outerHTML = renderDocTags(file);
  }

  return true;
}

async function addCustomTag(file, tag) {
  tag = (tag || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');

  if (!file || !tag) return;
  const folderSet = new Set(folderTagsOf(file.path));

  if (folderSet.has(tag)) return; // already covered by the folder
  const custom = (file.tags || []).filter((t) => !folderSet.has(t));

  if (custom.includes(tag)) return;
  custom.push(tag);
  await persistTags(file, custom);
}

async function removeCustomTag(file, tag) {
  if (!file) return;
  const folderSet = new Set(folderTagsOf(file.path));
  const custom = (file.tags || []).filter((t) => !folderSet.has(t) && t !== tag);

  await persistTags(file, custom);
}

// Tag editing popup anchored below the « + » button.
let tagEditorEl = null;

function closeTagEditor() {
  if (tagEditorEl) {
    tagEditorEl.remove();
    tagEditorEl = null;
  }
}

function openTagEditor(file, anchorEl) {
  if (!file) return;
  closeTagEditor();
  const folderSet = new Set(folderTagsOf(file.path));
  const el = document.createElement('div');

  el.id = 'tag-editor';
  el.className =
    'fixed z-50 w-64 bg-navy-800 border subtle-border rounded-lg shadow-2xl shadow-black/70 p-3';
  el.innerHTML =
    '<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-2 font-sans">' +
    t('tagEditorTitle') +
    '</div>' +
    '<div id="tag-ed-list" class="flex flex-wrap gap-1.5 mb-2"></div>' +
    '<input id="tag-ed-input" list="tag-ed-dl" placeholder="' +
    escapeHtml(t('tagPlaceholder')) +
    '" autocomplete="off" class="w-full px-2 py-1.5 text-sm bg-black/30 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40">' +
    '<datalist id="tag-ed-dl"></datalist>' +
    '<div class="text-[10px] text-ink-500 mt-1.5 font-sans">' +
    t('tagEditorHint') +
    '</div>';
  document.body.appendChild(el);
  tagEditorEl = el;
  const r = anchorEl.getBoundingClientRect();

  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 272)) + 'px';
  el.style.top = r.bottom + 6 + 'px';
  const dl = el.querySelector('#tag-ed-dl');
  const refreshDl = () => {
    dl.innerHTML = allTagsList()
      .map((t) => '<option value="' + escapeHtml(t) + '">')
      .join('');
  };

  const input = el.querySelector('#tag-ed-input');
  const renderList = () => {
    const cur = (file.tags || []).filter((t) => !folderSet.has(t));
    const box = el.querySelector('#tag-ed-list');

    box.innerHTML = cur.length
      ? cur
          .map(
            (t) =>
              '<span class="doc-tag" style="cursor:default">#' +
              escapeHtml(t) +
              '<button class="doc-tag-x" data-ed-rm="' +
              escapeHtml(t) +
              '">×</button></span>',
          )
          .join('')
      : '<span class="text-[11px] text-ink-500">' + t('noCustomTags') + '</span>';
    box.querySelectorAll('[data-ed-rm]').forEach((b) =>
      b.addEventListener('click', async () => {
        await removeCustomTag(file, b.dataset.edRm);
        renderList();
      }),
    );
  };

  refreshDl();
  renderList();
  input.focus();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value;

      input.value = '';

      if (v.trim()) {
        await addCustomTag(file, v);
        refreshDl();
        renderList();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeTagEditor();
    }
  });
}

document.addEventListener('click', (e) => {
  if (tagEditorEl && !tagEditorEl.contains(e.target) && !e.target.closest('.doc-tag-add'))
    closeTagEditor();
});

// View « all docs carrying this tag ».
function showTag(tag) {
  if (editMode) exitEditMode(false);
  currentFile = null;
  document.querySelector('main').scrollTop = 0;
  const docs = Object.values(fileMap)
    .filter((f) => f.ext === '.md' && (f.tags || []).includes(tag))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  let html =
    '<h1 class="!mb-1">#' +
    escapeHtml(tag) +
    '</h1>' +
    '<p class="lead text-ink-400 !mt-0">' +
    t('docsWithTag', docs.length) +
    '</p>' +
    '<ul class="not-prose mt-6 space-y-2">';

  for (const f of docs) {
    html +=
      '<li><a class="block p-3 bg-black/20 hover:bg-black/30 border subtle-border rounded-lg cursor-pointer transition" data-tagdoc="' +
      escapeHtml(f.path) +
      '">' +
      '<div class="text-sm text-ink-100 font-medium font-sans truncate">' +
      escapeHtml(f.name) +
      '</div>' +
      '<div class="text-[10px] text-ink-500 mt-0.5 font-mono truncate">' +
      escapeHtml(f.path) +
      '</div></a></li>';
  }

  contentEl.innerHTML = html + '</ul>';
  contentEl.querySelectorAll('[data-tagdoc]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.tagdoc];

      if (f) {
        showMarkdown(f);
        history.replaceState(null, '', '#' + encodeURIComponent(f.path));
      }
    }),
  );
  breadcrumbPath.textContent = '#' + tag;
  breadcrumbDate.textContent = '';
  breadcrumbActions.classList.add('hidden');
  breadcrumbActions.classList.remove('flex');
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');
  document.querySelectorAll('.tree-item').forEach((el) => el.classList.remove('active'));
}

// Delegation: clicks on tag chips and wikilinks rendered in the content.
contentEl.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-removetag]');

  if (rm) {
    e.preventDefault();
    e.stopPropagation();
    removeCustomTag(currentFile, rm.dataset.removetag);

    return;
  }

  const add = e.target.closest('.doc-tag-add');

  if (add) {
    e.preventDefault();
    openTagEditor(currentFile, add);

    return;
  }

  const tagBtn = e.target.closest('.doc-tag');

  if (tagBtn && tagBtn.dataset.tag) {
    e.preventDefault();
    showTag(tagBtn.dataset.tag);

    return;
  }

  const wl = e.target.closest('a.wikilink');

  if (wl) {
    e.preventDefault();
    const f = wl.dataset.path && fileMap[wl.dataset.path];

    if (f) {
      showMarkdown(f);
      history.replaceState(null, '', '#' + encodeURIComponent(f.path));
    }
  }
});

// Highlights + scrolls to the 1st occurrence of a search term in the rendered doc.
// Walks text nodes to avoid breaking marked's HTML. Case-insensitive; on an accent
// mismatch there's no match and the scroll stays at the top.
function highlightFirstMatch(container, query) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!tokens.length) return;
  const re = new RegExp('(' + tokens.join('|') + ')', 'i');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue && re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const node = walker.nextNode();

  if (!node) return;
  const m = node.nodeValue.match(re);

  if (!m) return;
  const after = node.splitText(m.index);

  after.nodeValue = after.nodeValue.slice(m[0].length);
  const mark = document.createElement('mark');

  mark.className = 'search-hit';
  mark.textContent = m[0];
  after.parentNode.insertBefore(mark, after);
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function mdInsertWrap(before, after, placeholderIfEmpty) {
  if (!editTextarea) return;
  const start = editTextarea.selectionStart;
  const end = editTextarea.selectionEnd;
  const sel = editTextarea.value.substring(start, end) || placeholderIfEmpty || '';
  const replacement = before + sel + after;

  editTextarea.setRangeText(replacement, start, end, 'end');

  if (
    !editTextarea.value.substring(start, end + replacement.length - (before.length + after.length))
  ) {
    editTextarea.selectionStart = editTextarea.selectionEnd = start + before.length + sel.length;
  } else {
    editTextarea.selectionStart = start + before.length;
    editTextarea.selectionEnd = start + before.length + sel.length;
  }

  editTextarea.dispatchEvent(new Event('input'));
}

function mdInsertLineStart(prefix) {
  if (!editTextarea) return;
  const v = editTextarea.value;
  const start = editTextarea.selectionStart;
  let lineStart = start;

  while (lineStart > 0 && v[lineStart - 1] !== '\n') lineStart--;
  editTextarea.setRangeText(prefix, lineStart, lineStart, 'end');
  editTextarea.selectionStart = editTextarea.selectionEnd = start + prefix.length;
  editTextarea.dispatchEvent(new Event('input'));
}

function mdInsertAtCursor(text) {
  if (!editTextarea) return;
  const start = editTextarea.selectionStart;

  editTextarea.setRangeText(text, start, editTextarea.selectionEnd, 'end');
  editTextarea.dispatchEvent(new Event('input'));
}
