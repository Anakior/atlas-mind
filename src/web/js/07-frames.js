function renderHtmlFrame(file) {
  btnEdit.classList.add('hidden'); // no inline HTML editing via the viewer
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  // The prose article is narrow and padded: full width for the deck.
  contentEl.style.maxWidth = 'none';
  contentEl.style.padding = '0';
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const u = escapeHtml(url);
  // Online: iframe src=URL. Offline (file://) the absolute URL doesn't resolve →
  // inject the embedded content via srcdoc.
  const offlineSrc =
    typeof IS_OFFLINE_BUILD !== 'undefined' && IS_OFFLINE_BUILD
      ? file.content != null
        ? file.content
        : typeof EMBED_CONTENT !== 'undefined'
          ? EMBED_CONTENT[file.path]
          : null
      : null;
  const frameAttr =
    offlineSrc != null ? 'srcdoc="' + escapeHtml(offlineSrc) + '"' : 'src="' + u + '"';

  contentEl.innerHTML =
    '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs">' +
    '<span class="text-ink-400 font-mono">' +
    t('htmlDocBanner') +
    '</span>' +
    '<a href="' +
    u +
    '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' +
    t('openFullscreen') +
    '</a>' +
    '</div>' +
    '<iframe ' +
    frameAttr +
    ' sandbox="allow-scripts" allow="fullscreen" title="' +
    escapeHtml(file.name) +
    '" ' +
    'style="width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13"></iframe>';
  // TOC/backlinks/notes + todos widget make no sense over a standalone HTML doc:
  // hide them (restored on the next .md doc via showMarkdown).
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');
}

// Render a .pdf in the browser's native viewer via a same-origin iframe
// (X-Frame-Options SAMEORIGIN allows our own framing). Offline, a binary can't be
// inlined → we offer direct opening instead.
function renderPdfFrame(file) {
  btnEdit.classList.add('hidden');
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  contentEl.style.maxWidth = 'none';
  contentEl.style.padding = '0';
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const u = escapeHtml(url);
  const offline = typeof IS_OFFLINE_BUILD !== 'undefined' && IS_OFFLINE_BUILD;
  const body = offline
    ? '<div class="p-6 text-sm text-ink-400">' +
      t('pdfOfflineHint') +
      ' <a href="' +
      u +
      '" class="text-sky-400 hover:underline">' +
      escapeHtml(file.name) +
      '</a></div>'
    : '<iframe src="' +
      u +
      '" title="' +
      escapeHtml(file.name) +
      '" style="width:100%;height:calc(100vh - 150px);border:0;display:block;background:#0b0d13"></iframe>';

  contentEl.innerHTML =
    '<div class="flex items-center justify-between px-4 py-2 border-b border-navy-500 bg-navy-800 text-xs">' +
    '<span class="text-ink-400 font-mono">' +
    t('pdfDocBanner') +
    '</span>' +
    '<a href="' +
    u +
    '" target="_blank" rel="noopener" class="text-sky-400 hover:underline whitespace-nowrap ml-3">' +
    t('openFullscreen') +
    '</a>' +
    '</div>' +
    body;
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');
}

// mammoth.js (DOCX → HTML) loaded ON DEMAND: ~640 KB, no point embedding it
// in the <head> when most sessions never open a .docx.
let _mammothPromise = null;

function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);

  if (_mammothPromise) return _mammothPromise;
  _mammothPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');

    s.src = '/vendor/mammoth.min.js';
    s.onload = () => (window.mammoth ? resolve(window.mammoth) : reject(new Error('mammoth')));
    s.onerror = () => {
      _mammothPromise = null;
      reject(new Error('mammoth load failed'));
    };

    document.head.appendChild(s);
  });

  return _mammothPromise;
}

// .docx → HTML via mammoth, injected into .prose. Read-only, client-side.
async function renderDocxFrame(file) {
  btnEdit.classList.add('hidden');
  btnSave.classList.add('hidden');
  btnCancel.classList.add('hidden');
  contentEl.style.maxWidth = '';
  contentEl.style.padding = '';
  contentEl.innerHTML = renderSkeleton(file);
  tocList.innerHTML = '';
  tocLinks.innerHTML = '';
  tocNotes.innerHTML = '';
  tocPanel.classList.add('hidden');
  tocPanel.classList.remove('flex');

  if (typeof tocShow !== 'undefined' && tocShow) tocShow.classList.add('hidden');
  document.getElementById('todo-widget')?.classList.add('hidden');

  try {
    const mammoth = await loadMammoth();
    const url =
      '/' +
      file.path.split('/').map(encodeURIComponent).join('/') +
      (file.mtime ? '?v=' + file.mtime : '');
    const buf = await (await fetch(url, { cache: 'no-cache' })).arrayBuffer();

    if (currentFile !== file) return; // page changed during the fetch/parse
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });

    if (currentFile !== file) return;
    contentEl.innerHTML = '<div class="docx-doc">' + DOMPurify.sanitize(result.value) + '</div>';
  } catch (e) {
    if (currentFile !== file) return;
    const url = '/' + file.path.split('/').map(encodeURIComponent).join('/');

    contentEl.innerHTML =
      '<div class="text-rose-400 text-sm">' +
      escapeHtml(t('docxError', e.message)) +
      ' <a href="' +
      escapeHtml(url) +
      '" class="text-sky-400 hover:underline">' +
      escapeHtml(file.name) +
      '</a></div>';
  }
}

// Strips the leading YAML frontmatter (--- ... ---) before rendering (same regex
// as the build). The raw content keeps the frontmatter (tag editing).
