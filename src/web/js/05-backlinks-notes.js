let backlinksIndex = null;
let backlinksLoading = null;

async function loadBacklinksIndex() {
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
    return backlinksIndex;
  })();
  return backlinksLoading;
}

async function renderBacklinksFor(file) {
  // Synchronous reset (before the await): applyToc() from buildToc() will see a clean state.
  tocHasLinks = false;
  if (tocLinks) { tocLinks.innerHTML = ''; tocLinks.classList.remove('border-t', 'panel-divider'); }
  const idx = await loadBacklinksIndex();
  if (currentFile !== file) return; // user changed page mid-load
  const entry = idx[file.path] || { out: [], in: [] };
  const resolve = (paths) => (paths || []).map(p => fileMap[p]).filter(Boolean);
  const incoming = resolve(entry.in);
  const outgoing = resolve(entry.out);
  // Same-topic docs: shared tags (excluding the current doc), ranked by shared-tag
  // count then recency.
  const tagSet = new Set(file.tags || []);
  const shared = (f) => (f.tags || []).filter(t => tagSet.has(t)).length;
  const related = tagSet.size
    ? Object.values(fileMap)
        .filter(f => f.ext === '.md' && f.path !== file.path && shared(f) > 0)
        .sort((a, b) => shared(b) - shared(a) || (b.mtime || 0) - (a.mtime || 0))
        .slice(0, 8)
    : [];
  tocHasLinks = !!(incoming.length || outgoing.length || related.length);
  tocLinks.classList.toggle('hidden', !tocHasLinks);   // empty section → no gap
  if (!tocHasLinks) { applyToc(); return; }
  const card = (f) =>
    '<a class="block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent cursor-pointer truncate" ' +
    'data-conn="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.name) + '</a>';
  const group = (title, items) => items.length
    ? '<div class="mt-2"><div class="px-2 pb-0.5 text-[10px] uppercase tracking-[0.1em] text-ink-500 font-bold">' + title + '</div>' + items.map(card).join('') + '</div>'
    : '';
  tocLinks.classList.add('border-t', 'panel-divider');
  tocLinks.innerHTML =
    '<div class="px-2 pb-1 text-[10px] uppercase tracking-[0.12em] text-accent font-bold">' + t('linksTitle') + '</div>' +
    group(t('referencedBy', incoming.length), incoming) +
    group(t('outgoingLinks', outgoing.length), outgoing) +
    group(t('sameTopic', related.length), related);
  tocLinks.querySelectorAll('[data-conn]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const f = fileMap[a.dataset.conn];
      if (f) { showMarkdown(f); history.replaceState(null, '', '#' + encodeURIComponent(f.path)); }
    });
  });
  applyToc();
}

// ─── Passage annotations ─────────────────────────────────────────────────────
// Data: sidecar .notes/<doc>.json server-side (offline: EMBED_NOTES). Text-quote
// anchoring (exact + prefix/suffix + approx. pos), W3C Web Annotation style:
// resilient to text shifts; if the passage disappears the note becomes orphaned.
const CTX_LEN = 60;            // captured prefix/suffix context length
const notesCanEdit = () => !IS_OFFLINE_BUILD && !window.__viewerMode;
let notesForDoc = [];          // notes of the current doc (anchors resolved on the fly)
// notesIndex ({path: count}, tree badges) is declared at the top of the script so
// it's visible from the top-level decorateTreeBadges().

const noteAddBtn = document.getElementById('kb-note-add');
const notePop = document.getElementById('kb-note-pop');

// Global text offset of a (node, offset) within contentEl, by walking the text
// nodes. -1 if the node isn't under contentEl.
function textOffsetOf(node, offset) {
  if (!contentEl.contains(node)) return -1;
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let acc = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return acc + offset;
    acc += n.nodeValue.length;
  }
  return -1;
}

// Builds a text-quote anchor from the current selection.
function selectionToAnchor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!contentEl.contains(r.commonAncestorContainer)) return null;
  const start = textOffsetOf(r.startContainer, r.startOffset);
  const end = textOffsetOf(r.endContainer, r.endOffset);
  if (start < 0 || end < 0 || end <= start) return null;
  const full = contentEl.textContent;
  const exact = full.slice(start, end);
  if (!exact.trim()) return null;
  return {
    exact,
    prefix: full.slice(Math.max(0, start - CTX_LEN), start),
    suffix: full.slice(end, end + CTX_LEN),
    pos: start,
  };
}

// Re-locates an anchor in the current text → {start, end} or null (orphan).
// Searches all occurrences of `exact`, scores by prefix/suffix context and
// proximity to `pos`, keeps the best one.
function locateAnchor(a) {
  const full = contentEl.textContent;
  if (!a.exact) return null;
  const idxs = [];
  let i = full.indexOf(a.exact);
  while (i !== -1) { idxs.push(i); i = full.indexOf(a.exact, i + 1); }
  if (!idxs.length) return null;
  let best = idxs[0], bestScore = -Infinity;
  for (const s of idxs) {
    let score = 0;
    const before = full.slice(Math.max(0, s - CTX_LEN), s);
    const after = full.slice(s + a.exact.length, s + a.exact.length + CTX_LEN);
    if (a.prefix && before.endsWith(a.prefix)) score += 100;
    else if (a.prefix) { let k = 0; while (k < a.prefix.length && before[before.length - 1 - k] === a.prefix[a.prefix.length - 1 - k]) k++; score += k; }
    if (a.suffix && after.startsWith(a.suffix)) score += 100;
    else if (a.suffix) { let k = 0; while (k < a.suffix.length && after[k] === a.suffix[k]) k++; score += k; }
    score -= Math.abs(s - (a.pos || 0)) / 1000;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { start: best, end: best + a.exact.length };
}

// Wraps the global text range [start,end) in <mark> (one per traversed text node),
// with data-* + click handler. Injected AFTER DOMPurify, so the note text never
// goes through markdown rendering.
function highlightRange(start, end, note) {
  const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
  let acc = 0, n;
  const todo = [];
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    const ns = acc, ne = acc + len;
    if (ne > start && ns < end) {
      todo.push({ node: n, from: Math.max(0, start - ns), to: Math.min(len, end - ns) });
    }
    acc = ne;
    if (ns >= end) break;
  }
  for (const t of todo) {
    let node = t.node;
    if (t.to < node.nodeValue.length) node.splitText(t.to);
    if (t.from > 0) node = node.splitText(t.from);
    const mark = document.createElement('mark');
    mark.className = 'kb-annot';
    mark.dataset.noteId = note.id;
    node.parentNode.insertBefore(mark, node);
    mark.appendChild(node);
    mark.addEventListener('click', (e) => { e.stopPropagation(); openNotePopForExisting(note, mark); });
  }
  return todo.length > 0;
}

async function fetchNotes(file) {
  if (IS_OFFLINE_BUILD) return (EMBED_NOTES && EMBED_NOTES[file.path]) || [];
  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(file.path), { cache: 'no-cache' });
    return res.ok ? await res.json() : [];
  } catch (e) { return []; }
}

async function renderNotesFor(file) {
  tocHasNotes = false;
  if (tocNotes) { tocNotes.innerHTML = ''; tocNotes.classList.remove('border-t', 'panel-divider'); }
  notesForDoc = [];
  const notes = await fetchNotes(file);
  if (currentFile !== file) return;               // page changed during the fetch
  notesForDoc = notes;
  if (!notes.length) { applyToc(); return; }
  // Resolve each anchor in the rendered DOM and highlight it.
  notes.forEach(note => {
    const loc = locateAnchor(note);
    note._orphan = !(loc && highlightRange(loc.start, loc.end, note));
  });
  renderNotesPanel(file);
}

function renderNotesPanel(file) {
  tocHasNotes = notesForDoc.length > 0;
  tocNotes.classList.toggle('hidden', !tocHasNotes);   // empty section → no gap
  if (!tocHasNotes) { applyToc(); return; }
  const row = (note) =>
    '<button class="kb-note-row' + (note._orphan ? ' kb-orphan' : '') + '" data-note-id="' + escapeHtml(note.id) + '">' +
      '<span class="kb-note-snip">' + escapeHtml(note.note.length > 90 ? note.note.slice(0, 90) + '…' : note.note) + '</span>' +
      '<span class="kb-note-meta">' + (note._orphan ? t('orphanShort') : '“' + escapeHtml(note.exact.length > 40 ? note.exact.slice(0, 40) + '…' : note.exact) + '”') + '</span>' +
    '</button>';
  tocNotes.classList.add('border-t', 'panel-divider');
  // Header with counter + « copy all notes » button (share annotations, incl.
  // from a read-only remote node).
  tocNotes.innerHTML =
    '<div class="px-2 pb-1 flex items-center justify-between gap-2">' +
      '<span class="text-[10px] uppercase tracking-[0.12em] text-amber-300 font-bold">' + t('notesTitle', notesForDoc.length) + '</span>' +
      '<button id="toc-notes-copy" class="p-0.5 -mr-0.5 text-ink-500 hover:text-amber-300 rounded hover:bg-white/5 flex-shrink-0" title="' + escapeHtml(t('copyAllNotes')) + '"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184"/></svg></button>' +
    '</div>' +
    notesForDoc.map(row).join('');
  const copyBtn = tocNotes.querySelector('#toc-notes-copy');
  if (copyBtn) copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyAllNotes(copyBtn); });
  tocNotes.querySelectorAll('[data-note-id]').forEach(el => {
    el.addEventListener('click', () => {
      const note = notesForDoc.find(n => n.id === el.dataset.noteId);
      if (!note) return;
      const mark = contentEl.querySelector('mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]');
      if (mark) { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); openNotePopForExisting(note, mark); }
      else openNotePopForExisting(note, el);   // orphan: anchor the popover on the row
    });
  });
  applyToc();
}

// Copies all notes of the current doc as markdown (quote + note) for sharing.
async function copyAllNotes(btn) {
  if (!notesForDoc.length) return;
  const lines = [];
  const title = currentFile ? (currentFile.name || currentFile.path) : '';
  if (title) lines.push('# Notes — ' + title, '');
  notesForDoc.forEach(n => {
    if (n.exact && !n._orphan) lines.push('> ' + n.exact);
    lines.push(n.note, '');
  });
  await copyToClipboard(lines.join('\n').trim() + '\n');
  if (btn) { btn.classList.add('text-emerald-400'); setTimeout(() => btn.classList.remove('text-emerald-400'), 1200); }
  setStatus(t('notesCopied', notesForDoc.length), 'ok');
}

// ─── Popover create / read-edit ──────────────────────────────────────────────
let pendingAnchor = null;

function positionPop(el, anchorRect) {
  const margin = 8;
  let top = window.scrollY + anchorRect.bottom + margin;
  let left = window.scrollX + anchorRect.left;
  el.style.display = 'block';
  const w = el.offsetWidth, h = el.offsetHeight;
  if (left + w > window.scrollX + document.documentElement.clientWidth - margin)
    left = window.scrollX + document.documentElement.clientWidth - w - margin;
  if (anchorRect.bottom + margin + h > document.documentElement.clientHeight)
    top = window.scrollY + anchorRect.top - h - margin;
  el.style.top = Math.max(window.scrollY + margin, top) + 'px';
  el.style.left = Math.max(margin, left) + 'px';
}

function closeNotePop() {
  notePop.style.display = 'none';
  notePop.innerHTML = '';
  pendingAnchor = null;
  contentEl.querySelectorAll('mark.kb-annot.kb-annot-active').forEach(m => m.classList.remove('kb-annot-active'));
}

function openNotePopForNew(anchor, rect) {
  pendingAnchor = anchor;
  notePop.innerHTML =
    '<div class="kb-quote">“' + escapeHtml(anchor.exact.length > 160 ? anchor.exact.slice(0, 160) + '…' : anchor.exact) + '”</div>' +
    '<textarea placeholder="' + escapeHtml(t('notePlaceholder')) + '"></textarea>' +
    '<div class="kb-pop-actions"><button class="kb-btn-ghost" data-act="cancel">' + t('cancel') + '</button><button class="kb-btn-save" data-act="save">' + t('save') + '</button></div>';
  positionPop(notePop, rect);
  const ta = notePop.querySelector('textarea');
  ta.focus();
  notePop.querySelector('[data-act="cancel"]').onclick = closeNotePop;
  notePop.querySelector('[data-act="save"]').onclick = () => saveNewNote(ta.value);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNewNote(ta.value); });
}

function openNotePopForExisting(note, anchorEl) {
  closeNotePop();
  contentEl.querySelectorAll('mark.kb-annot[data-note-id="' + CSS.escape(note.id) + '"]').forEach(m => m.classList.add('kb-annot-active'));
  const canEdit = notesCanEdit();
  const meta = note.created ? relativeDate(note.created) : '';
  notePop.innerHTML =
    (note._orphan ? '<div class="kb-quote">' + t('orphanLong', escapeHtml(note.exact.slice(0, 120))) + '</div>' : '') +
    (canEdit
      ? '<textarea>' + escapeHtml(note.note) + '</textarea>'
      : '<div style="font-size:0.82rem;color:#e7e7ec;white-space:pre-wrap">' + escapeHtml(note.note) + '</div>') +
    (meta ? '<div class="kb-note-meta" style="font-size:0.66rem;color:#6b7280;margin-top:0.5rem">' + meta + '</div>' : '') +
    '<div class="kb-pop-actions">' +
      (canEdit ? '<button class="kb-btn-del" data-act="del">' + t('del') + '</button>' : '') +
      '<button class="kb-btn-ghost" data-act="cancel">' + t('close') + '</button>' +
      (canEdit ? '<button class="kb-btn-save" data-act="save">' + t('save') + '</button>' : '') +
    '</div>';
  positionPop(notePop, anchorEl.getBoundingClientRect());
  notePop.querySelector('[data-act="cancel"]').onclick = closeNotePop;
  if (canEdit) {
    const ta = notePop.querySelector('textarea');
    ta.focus();
    notePop.querySelector('[data-act="save"]').onclick = () => saveEditNote(note, ta.value);
    notePop.querySelector('[data-act="del"]').onclick = () => deleteNote(note);
  }
}

async function saveNewNote(text) {
  text = (text || '').trim();
  if (!text || !pendingAnchor || !currentFile) return;
  const body = Object.assign({ path: currentFile.path, note: text }, pendingAnchor);
  try {
    const res = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) { alert(t('noteSaveFailed', e.message)); return; }
  closeNotePop();
  window.getSelection().removeAllRanges();
  refreshNotes();
}

async function saveEditNote(note, text) {
  text = (text || '').trim();
  if (!text || !currentFile) return;
  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(currentFile.path) + '&id=' + encodeURIComponent(note.id),
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: text }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) { alert(t('actionFailed', e.message)); return; }
  closeNotePop();
  refreshNotes();
}

async function deleteNote(note) {
  if (!currentFile) return;
  const ok = await confirmDialog({
    title: t('deleteNoteTitle'),
    message: t('deleteNoteMsg', note.note.length > 80 ? note.note.slice(0, 80) + '…' : note.note),
    confirmLabel: t('del'),
    destructive: true,
  });
  if (!ok) return;
  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(currentFile.path) + '&id=' + encodeURIComponent(note.id), { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) { alert(t('actionFailed', e.message)); return; }
  closeNotePop();
  refreshNotes();
}

// Full re-render of the current doc + live tree-badge update. We recount notes
// from the SOURCE (/api/notes) because _notes-index.json is only regenerated at
// the next build — without this the badge only appeared after a reload.
async function refreshNotes() {
  if (!currentFile) return;
  const path = currentFile.path;
  try {
    const res = await fetch('/api/notes?path=' + encodeURIComponent(path), { cache: 'no-cache' });
    const list = res.ok ? await res.json() : null;
    if (Array.isArray(list)) {
      const idx = await loadNotesIndex();
      if (list.length) idx[path] = list.length; else delete idx[path];
      decorateTreeBadges();
    }
  } catch (_) {}
  showMarkdown(currentFile);
}

// Text selection → floating "Note" button (edit mode only). We store the anchor +
// rect at selection time, so the button tap doesn't need the selection to survive
// (on mobile the tap collapses it).
function updateNoteButton() {
  // Notes anchor into a markdown doc: no meaning on the home page (no currentFile)
  // nor a .html/.pdf (isolated iframe).
  if (!notesCanEdit() || editMode || notePop.style.display === 'block'
      || !currentFile || currentFile.ext !== '.md') {
    noteAddBtn.style.display = 'none';
    return;
  }
  const a = selectionToAnchor();
  if (!a) { noteAddBtn.style.display = 'none'; return; }
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  noteAddBtn._anchor = a;
  noteAddBtn._rect = rect;
  noteAddBtn.style.display = 'inline-flex';
  // Placed BELOW the selection: the native copy/paste bar (mobile) is above it.
  const bw = noteAddBtn.offsetWidth || 96;
  let left = window.scrollX + rect.left;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - bw - 8;
  if (left > maxLeft) left = maxLeft;
  noteAddBtn.style.top = (window.scrollY + rect.bottom + 8) + 'px';
  noteAddBtn.style.left = Math.max(8, left) + 'px';
}
// Desktop: immediate mouseup. Mobile/keyboard: selectionchange (touch handles emit
// no mouseup) debounced until the selection stabilizes — the delay also lets the
// button tap land before the collapse clears it.
let _selTimer = null;
contentEl.addEventListener('mouseup', () => setTimeout(updateNoteButton, 10));
document.addEventListener('selectionchange', () => {
  clearTimeout(_selTimer);
  _selTimer = setTimeout(updateNoteButton, 350);
});
function triggerNoteCreate() {
  if (!noteAddBtn._anchor) return;
  noteAddBtn.style.display = 'none';
  openNotePopForNew(noteAddBtn._anchor, noteAddBtn._rect);
}
noteAddBtn.addEventListener('click', triggerNoteCreate);
// dedicated touchend: on mobile the click can be swallowed by the selection dismiss.
noteAddBtn.addEventListener('touchend', (e) => { e.preventDefault(); triggerNoteCreate(); });
function maybeCloseOutside(e) {
  if (!notePop.contains(e.target) && e.target !== noteAddBtn && !noteAddBtn.contains(e.target)
      && !e.target.closest('mark.kb-annot') && !e.target.closest('.kb-note-row')) {
    if (notePop.style.display === 'block') closeNotePop();
    if (!e.target.closest('#content')) noteAddBtn.style.display = 'none';
  }
}
document.addEventListener('mousedown', maybeCloseOutside);
document.addEventListener('touchstart', maybeCloseOutside, { passive: true });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeNotePop(); noteAddBtn.style.display = 'none'; } });

// Notes index (tree badges). Online: _notes-index.json ; offline: EMBED_NOTES.
async function loadNotesIndex() {
  if (notesIndex) return notesIndex;
  if (IS_OFFLINE_BUILD) {
    notesIndex = {};
    for (const p in (EMBED_NOTES || {})) notesIndex[p] = EMBED_NOTES[p].length;
    return notesIndex;
  }
  try {
    const res = await fetch('/_notes-index.json', { cache: 'no-cache' });
    notesIndex = res.ok ? await res.json() : {};
  } catch (e) { notesIndex = {}; }
  return notesIndex;
}

async function decorateTreeBadges() {
  const idx = await loadNotesIndex();
  document.querySelectorAll('.kb-tree-badge').forEach(b => b.remove());
  for (const path in idx) {
    const link = treeEl.querySelector('a[data-path="' + CSS.escape(path) + '"]');
    if (!link) continue;
    const badge = document.createElement('span');
    badge.className = 'kb-tree-badge';
    badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg><span>' + idx[path] + '</span>';
    badge.title = t('notesBadge', idx[path]);
    link.appendChild(badge);
  }
}

function attachCopyButtons() {
  contentEl.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'copy-btn absolute top-2 right-2 opacity-0 transition-opacity px-2 py-1 text-[11px] bg-white/8 hover:bg-white/15 text-ink-300 hover:text-white rounded font-mono';
    btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' + t('copy');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const code = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' + t('copied');
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerHTML = '<svg class="w-3 h-3 inline mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>' + t('copy');
          btn.classList.remove('text-emerald-400');
        }, 1500);
      } catch (e) {}
    });
    pre.appendChild(btn);
    pre.addEventListener('mouseenter', () => btn.style.opacity = '1');
    pre.addEventListener('mouseleave', () => btn.style.opacity = '0');
  });
}

