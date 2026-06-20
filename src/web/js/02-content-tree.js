const contentCache = new Map();

async function loadContent(file) {
  if (file.content != null) return file.content;

  if (contentCache.has(file.path)) {
    file.content = contentCache.get(file.path);

    return file.content;
  }

  if (IS_OFFLINE_BUILD) {
    const c = EMBED_CONTENT[file.path];

    if (c == null) throw new Error(t('offlineMissing'));
    contentCache.set(file.path, c);
    file.content = c;

    return c;
  }

  // Versioned by mtime for cache busting.
  const url =
    '/' +
    file.path.split('/').map(encodeURIComponent).join('/') +
    (file.mtime ? '?v=' + file.mtime : '');
  const res = await fetch(url);

  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();

  contentCache.set(file.path, text);
  file.content = text;

  return text;
}

// Shared between todo widget and showWelcome; declared early to avoid TDZ.
let todos = [];
// Notes index {path: count} for tree badges. Declared early: decorateTreeBadges()
// runs at top-level right after the tree renders, before the annotations section
// (otherwise TDZ → ReferenceError, badges missing on first render).
let notesIndex = null;

const ICONS = {
  '.md':
    '<svg class="w-4 h-4 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  '.pdf':
    '<svg class="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
  '.pptx':
    '<svg class="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/></svg>',
  '.html':
    '<svg class="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
  '.docx':
    '<svg class="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
};
const FOLDER_ICON =
  '<svg class="w-4 h-4 text-[#fbc678] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>';
// « Mental nodes » umbrella icon: teal network node, distinct from the yellow folder.
const REMOTE_FOLDER_ICON =
  '<svg class="w-4 h-4 text-[#59d0cf] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>';
// « Share as node » icon (Heroicons link) shown on hover over folders/docs.
const LINK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>';
// « Rename » icon (Heroicons pencil).
const PENCIL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.862 4.487Z"/></svg>';
const FILE_ICON =
  '<svg class="w-4 h-4 text-ink-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';

function iconFor(ext) {
  return ICONS[ext] || FILE_ICON;
}

function renderTree(node, depth = 0, prefix = '') {
  const ul = document.createElement('ul');

  ul.className =
    depth === 0 ? 'space-y-0.5' : 'ml-3 border-l border-navy-600 pl-2 space-y-0.5 mt-0.5';

  for (const child of node.children || []) {
    const li = document.createElement('li');

    if (child.type === 'dir') {
      const childPath = prefix ? prefix + '/' + child.name : child.name;
      // remotes/ = mirrors of remote nodes: read-only (rename hidden by .tree-remote CSS).
      const isRemoteRoot = childPath === 'remotes';
      const isRemote = isRemoteRoot || childPath.startsWith('remotes/');
      const btn = document.createElement('button');

      btn.className =
        'tree-item group w-full text-left px-2 py-1.5 rounded flex items-center gap-2 font-semibold text-ink-100' +
        (isRemote ? ' tree-remote' : '');
      btn.dataset.dirPath = childPath;
      // remotes/ umbrella → label « Mental nodes »; children keep their name
      // and get their origin via decorateRemoteOrigins().
      const dirLabel = isRemoteRoot ? t('remotesLabel') : child.name;
      // « Share as node » on hover, not on mirrors (don't re-publish another atlas's content).
      const dirShareBtn = isRemote
        ? ''
        : `<span class="dir-share-btn tree-action-btn tree-action-btn--share" title="${t('shareAsNode')}">${LINK_ICON}</span>`;
      // Manage the folder's ACL (model B): cascades to children by inheritance.
      const dirAccessBtn = isRemote
        ? ''
        : `<span class="dir-access-btn tree-action-btn" title="${t('aclBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></span>`;

      btn.innerHTML = `<span class="caret text-xs text-ink-400">&#9656;</span>${isRemoteRoot ? REMOTE_FOLDER_ICON : FOLDER_ICON}<span class="truncate min-w-0 flex-1" data-name="${escapeHtml(child.name)}">${escapeHtml(dirLabel)}</span>${dirAccessBtn}<span class="dir-rename-btn tree-action-btn" title="${t('renameFolder')}">${PENCIL_ICON}</span>${dirShareBtn}`;
      const sub = renderTree(child, depth + 1, childPath);

      sub.classList.add('hidden');
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.dir-access-btn')) {
          e.stopPropagation();
          if (window.openAccessFor) window.openAccessFor(childPath);

          return;
        }

        if (e.target.closest('.dir-share-btn')) {
          e.stopPropagation();
          openPublishNode(childPath);

          return;
        }

        if (e.target.closest('.dir-rename-btn')) {
          e.stopPropagation();
          openDirRenameModal(childPath);

          return;
        }

        sub.classList.toggle('hidden');
        btn.querySelector('.caret').classList.toggle('open');
      });

      if (depth === 0) {
        sub.classList.remove('hidden');
        btn.querySelector('.caret').classList.add('open');
      }

      li.appendChild(btn);
      li.appendChild(sub);
    } else {
      const isRemoteFile = child.path.startsWith('remotes/');
      const a = document.createElement('a');

      a.className =
        'tree-item group w-full px-2 py-1.5 rounded flex items-start gap-2 cursor-pointer text-ink-200' +
        (isRemoteFile ? ' tree-remote' : '');
      a.dataset.path = child.path;
      const nameHtml = `<span class="truncate min-w-0 flex-1 leading-snug" data-name="${escapeHtml(child.name)}">${escapeHtml(child.name)}</span>`;
      // Sharing-state dot: private = amber, shared-by-me = sky,
      // shared-with-me (granted) = emerald, commons = none.
      const visBadge =
        child.vis === 'private'
          ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(251,191,36,.85)" title="${t('visPrivate')}"></span>`
          : child.vis === 'shared'
            ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(56,189,248,.85)" title="${t('visShared')}"></span>`
            : child.vis === 'granted'
              ? `<span class="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full" style="background-color:rgba(52,211,153,.9)" title="${t('visGranted')}"></span>`
              : '';
      // Buttons on hover over your own document (.md/.html): rename + share.
      const fileActionable = !isRemoteFile && (child.ext === '.md' || child.ext === '.html');
      const fileRenameBtn = fileActionable
        ? `<span class="file-rename-btn tree-action-btn" title="${t('renameFile')}">${PENCIL_ICON}</span>`
        : '';
      const fileShareBtn = fileActionable
        ? `<span class="file-share-btn tree-action-btn tree-action-btn--share" title="${t('shareAsNode')}">${LINK_ICON}</span>`
        : '';
      // Manage the file's ACL (model B) — mirror of the folder's access button.
      const fileAccessBtn = fileActionable
        ? `<span class="file-access-btn tree-action-btn" title="${t('aclBtnTitle')}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg></span>`
        : '';

      a.innerHTML = `${iconFor(child.ext)}${nameHtml}${visBadge}${fileAccessBtn}${fileRenameBtn}${fileShareBtn}`;

      if (
        child.ext === '.md' ||
        child.ext === '.html' ||
        child.ext === '.pdf' ||
        child.ext === '.docx'
      ) {
        // showMarkdown dispatches: .md → marked, .html → iframe, .pdf → native, .docx → mammoth.
        a.addEventListener('click', (e) => {
          if (e.target.closest('.file-access-btn')) {
            e.preventDefault();
            e.stopPropagation();
            if (window.openAccessFor) window.openAccessFor(child.path);

            return;
          }

          if (e.target.closest('.file-share-btn')) {
            e.preventDefault();
            e.stopPropagation();
            openPublishNode(child.path);

            return;
          }

          if (e.target.closest('.file-rename-btn')) {
            e.preventDefault();
            e.stopPropagation();
            showMarkdown(child);
            openRenameModal('rename');

            return;
          }

          e.preventDefault();
          showMarkdown(child);
          history.replaceState(null, '', '#' + encodeURIComponent(child.path));
        });
      } else {
        a.href = encodeURI(child.path);
      }

      li.appendChild(a);
    }

    ul.appendChild(li);
  }

  return ul;
}

// Under each mirror (remotes/<name>), show which atlas it comes from — useful
// when following several sources. Admin-only data → silent best-effort.
async function decorateRemoteOrigins() {
  let remotes;

  try {
    const resp = await fetch('/api/admin/remotes', { headers: { Accept: 'application/json' } });

    if (!resp.ok) return;
    remotes = await resp.json();
  } catch (_) {
    return;
  }

  if (!Array.isArray(remotes)) return;

  for (const r of remotes) {
    const host = (r.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    if (!host) continue;
    const sel =
      'button[data-dir-path="remotes/' +
      (window.CSS && CSS.escape ? CSS.escape(r.name) : r.name) +
      '"]';
    const btn = treeEl.querySelector(sel);

    if (!btn || btn.querySelector('.tree-remote-origin')) continue;
    const span = document.createElement('span');

    span.className = 'tree-remote-origin';
    span.textContent = host;
    span.title = r.url || '';
    btn.insertBefore(span, btn.querySelector('.dir-rename-btn'));
  }
}

// In SERVER mode the baked tree is the FULL build-time view (generated as the
// owner). Never render it — a viewer would see private names in the menu. The
// bootstrap fetches /api/tree (filtered per account) on init via softReload().
// Only the offline build renders the embedded tree directly. Gated on
// IS_OFFLINE_BUILD, NOT the protocol: GitHub Pages serves the offline build over
// https, so a file:// check would leave the demo with an empty tree.
if (IS_OFFLINE_BUILD) {
  treeEl.appendChild(renderTree(TREE));
  decorateTreeBadges();
  decorateRemoteOrigins();
}

marked.setOptions({ gfm: true, breaks: false });
// marked ≥ v5 removed the `highlight` setOptions option (silently ignored by the
// vendored v15), so we highlight in a custom `code` renderer instead. The hljs
// output survives DOMPurify; the `hljs` class enables the vendored github-dark theme.
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let html;

      try {
        html =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language }).value
            : hljs.highlightAuto(text).value;
      } catch (e) {
        html = escapeHtml(text);
      }

      const cls = language ? ' language-' + escapeHtml(language) : '';

      return '<pre><code class="hljs' + cls + '">' + html + '</code></pre>\n';
    },
  },
});

// ─── Wikilinks [[doc]] ─────────────────────────────────────────────────────────
// Target → path resolution (same logic as the build): direct path, else stem.
// Maps built once over fileMap. Any openable doc is a valid target, not just .md.
const WL_TARGET_EXTS = ['.md', '.html', '.pdf', '.docx'];
let _wlMaps = null;

function wlMaps() {
  if (_wlMaps) return _wlMaps;
  const byPath = {},
    byStem = {};

  for (const f of Object.values(fileMap)) {
    if (!WL_TARGET_EXTS.includes(f.ext)) continue;
    byPath[f.path.toLowerCase()] = f.path;
    const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();

    if (!(stem in byStem)) byStem[stem] = f.path;
  }

  _wlMaps = { byPath, byStem };

  return _wlMaps;
}
