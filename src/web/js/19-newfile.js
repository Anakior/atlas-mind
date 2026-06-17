function openQuickCapture() {
  if (window.__viewerMode) return;
  qcError.classList.add('hidden');
  qcTitle.value = '';
  qcBody.value = '';
  qcBackdrop.classList.remove('hidden');
  setTimeout(() => qcTitle.focus(), 50);
}

function closeQuickCapture() {
  qcBackdrop.classList.add('hidden');
}

qcBtn.addEventListener('click', openQuickCapture);
qcCancel.addEventListener('click', closeQuickCapture);
qcBackdrop.addEventListener('click', (e) => {
  if (e.target === qcBackdrop) closeQuickCapture();
});

qcForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  qcError.classList.add('hidden');
  const title = qcTitle.value.trim();

  if (!title) {
    qcError.textContent = t('titleRequired');
    qcError.classList.remove('hidden');

    return;
  }

  const body = qcBody.value.trim();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr =
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes());
  const slug = (slugify(title) || 'note').slice(0, 50);
  const path = 'inbox/' + dateStr + '-' + slug + '.md';
  const content =
    '# ' + title + '\n\n_Capture : ' + now.toLocaleString('fr-FR') + '_\n\n' + body + '\n';

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeQuickCapture();
    setStatus(t('noteSaved'), 'ok');
  } catch (e) {
    qcError.textContent = t('err', e.message);
    qcError.classList.remove('hidden');
  }
});

// ── New file modal ───────────────────────────────────────────────────────────
const newFileBtn = document.getElementById('new-file-btn');
const newFileBackdrop = document.getElementById('new-file-backdrop');
const newFileForm = document.getElementById('new-file-form');
const newFileDir = document.getElementById('new-file-dir');
const newFileName = document.getElementById('new-file-name');
const newFileDirs = document.getElementById('new-file-dirs');
const newFileTemplate = document.getElementById('new-file-template');
const newFileError = document.getElementById('new-file-error');
const newFileCancel = document.getElementById('new-file-cancel');
const newFileExtArea = document.getElementById('new-file-ext-area');

async function refreshTreeOrReload() {
  if (window.softReload) await window.softReload();
  else location.reload();
}

// Fills a DOC_TEMPLATES skeleton: tokens {{title}}, {{date}} (UI locale long
// form), {{isoDate}} (YYYY-MM-DD). Unknown kind (incl. 'blank') → title only.
function buildTemplateContent(kind, title) {
  const template = DOC_TEMPLATES && DOC_TEMPLATES[kind];

  if (!template) {
    return '# ' + title + '\n\n';
  }

  const locale = LANG === 'en' ? 'en-GB' : 'fr-FR';
  const today = new Date().toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const isoDate = new Date().toISOString().slice(0, 10);

  return template
    .replaceAll('{{title}}', title)
    .replaceAll('{{date}}', today)
    .replaceAll('{{isoDate}}', isoDate);
}

// "Blank" stays the reserved first option; skeleton names cannot override it.
(function populateTemplateOptions() {
  for (const name of Object.keys(DOC_TEMPLATES || {}).sort()) {
    if (name === 'blank') continue;
    const option = document.createElement('option');

    option.value = name;
    option.textContent = name;
    newFileTemplate.appendChild(option);
  }
})();

// ─── Extension templates + window.Atlas API ───────────────────────────────────
// Extensions (loaded after this script, inlined by build.py) register a
// new-document template and drive the viewer via window.Atlas. Events emitted on
// document: atlas:doc-rendered {path, markdown}, atlas:edit-enter.
// A modal carrying [data-atlas-modal] blocks the soft-reload while visible.
const templateProviders = Object.create(null);

function updateTemplateExtras() {
  const active = templateProviders[newFileTemplate.value] || null;

  for (const value in templateProviders) {
    const provider = templateProviders[value];

    if (provider.block) provider.block.classList.toggle('hidden', provider !== active);
  }

  newFileName.placeholder = (active && active.namePlaceholder) || t('docNamePlaceholder');

  if (active && active.defaultDir && !newFileDir.value.trim()) {
    newFileDir.value = active.defaultDir;
  }
}

window.Atlas = {
  version: 1,
  t,
  escapeHtml,
  setStatus,
  refresh: refreshTreeOrReload,
  // Markdown doc currently displayed ({path}) or null.
  currentDoc() {
    return currentFile ? { path: currentFile.path } : null;
  },
  // Drop a doc's cache after a write outside the viewer → next display re-fetches.
  invalidateDoc(path) {
    contentCache.delete(path);

    if (currentFile && currentFile.path === path) {
      currentFile.content = null;
      currentFile.mtime = 0;
    }
  },
  // Registers a new-document template. provider:
  //   label           : label of the select option (default: value)
  //   generate()      : async → {content, slug?}; a thrown error is shown
  //                     as-is to the user (message already localized)
  //   block           : optional form element (shown when selected)
  //   namePlaceholder : placeholder of the name field when selected
  //   defaultDir      : suggested folder if the folder field is empty
  //   successMessage  : status shown after creation (default: docCreated)
  //   onOpen()        : called on every opening of the modal (resets the block)
  // Rejected values: 'blank', a DOC_TEMPLATES skeleton with the same name, an
  // extension template already registered.
  registerTemplate(value, provider) {
    if (!value || !provider || typeof provider.generate !== 'function') return false;

    if (value === 'blank' || templateProviders[value] || (DOC_TEMPLATES && DOC_TEMPLATES[value]))
      return false;
    templateProviders[value] = provider;
    const option = document.createElement('option');

    option.value = value;
    option.textContent = provider.label || value;
    newFileTemplate.appendChild(option);

    if (provider.block) {
      provider.block.classList.add('hidden');
      newFileExtArea.appendChild(provider.block);
    }

    return true;
  },
};

function getAllDirs() {
  const dirs = new Set();

  (function walk(node, prefix) {
    for (const c of node.children || []) {
      if (c.type === 'dir') {
        const path = prefix ? prefix + '/' + c.name : c.name;

        dirs.add(path);
        walk(c, path);
      }
    }
  })(TREE, '');

  return Array.from(dirs).sort();
}

function openNewFileModal(presetDir) {
  if (window.__viewerMode) return;
  newFileError.classList.add('hidden');
  newFileDirs.innerHTML = getAllDirs()
    .map((d) => `<option value="${escapeHtml(d)}">`)
    .join('');
  newFileDir.value = presetDir || '';
  newFileName.value = '';
  newFileTemplate.value = 'blank';

  for (const value in templateProviders) {
    const provider = templateProviders[value];

    if (provider.onOpen) {
      try {
        provider.onOpen();
      } catch (err) {
        console.warn('[extension] onOpen', value, err);
      }
    }
  }

  updateTemplateExtras();
  newFileBackdrop.classList.remove('hidden');
  setTimeout(() => (presetDir ? newFileName : newFileDir).focus(), 50);
}

function closeNewFileModal() {
  newFileBackdrop.classList.add('hidden');
}

newFileBtn.addEventListener('click', () => openNewFileModal());
newFileCancel.addEventListener('click', closeNewFileModal);
newFileBackdrop.addEventListener('click', (e) => {
  if (e.target === newFileBackdrop) closeNewFileModal();
});
newFileTemplate.addEventListener('change', updateTemplateExtras);

function showNewFileError(msg) {
  newFileError.textContent = msg;
  newFileError.classList.remove('hidden');
}

newFileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  newFileError.classList.add('hidden');
  const dir = newFileDir.value.trim().replace(/^\/+|\/+$/g, '');
  let name = newFileName.value.trim();
  const provider = templateProviders[newFileTemplate.value] || null;

  let content;

  if (provider) {
    // Extension generator produces the content (+ fallback slug). Thrown error = user message.
    try {
      const built = await provider.generate();

      content = built.content;

      if (!name) name = (built.slug || '').trim();
    } catch (err) {
      return showNewFileError(err.message);
    }
  }

  if (!name) return showNewFileError(t('nameRequired'));

  if (/[\\\/]/.test(name)) return showNewFileError(t('noSlashes'));

  if (!name.endsWith('.md')) name += '.md';
  const path = dir ? dir + '/' + name : name;

  if (fileMap[path]) return showNewFileError(t('fileExists'));

  if (!provider) {
    const title = name
      .replace(/\.md$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());

    content = buildTemplateContent(newFileTemplate.value, title);
  }

  try {
    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });

    if (!res.ok) throw new Error('HTTP ' + res.status);
    closeNewFileModal();
    location.hash = '#' + encodeURIComponent(path);
    setStatus((provider && provider.successMessage) || t('docCreated'), 'ok');
    await refreshTreeOrReload();
  } catch (err) {
    showNewFileError(t('errSp', err.message));
  }
});

// ── Dir rename modal ─────────────────────────────────────────────────────────
const dirRenameBackdrop = document.getElementById('dir-rename-backdrop');
const dirRenameForm = document.getElementById('dir-rename-form');
const dirRenameInput = document.getElementById('dir-rename-input');
const dirRenameCurrent = document.getElementById('dir-rename-current');
const dirRenameError = document.getElementById('dir-rename-error');
const dirRenameCancel = document.getElementById('dir-rename-cancel');
let dirRenameSourcePath = null;

function openDirRenameModal(path) {
  if (window.__viewerMode || !path) return;
  dirRenameSourcePath = path;
  const parts = path.split('/');
  const name = parts[parts.length - 1];

  dirRenameCurrent.textContent = path;
  dirRenameInput.value = name;
  dirRenameError.classList.add('hidden');
  dirRenameBackdrop.classList.remove('hidden');
  setTimeout(() => {
    dirRenameInput.focus();
    dirRenameInput.select();
  }, 50);
}

function closeDirRenameModal() {
  dirRenameBackdrop.classList.add('hidden');
  dirRenameSourcePath = null;
}

dirRenameCancel.addEventListener('click', closeDirRenameModal);
dirRenameBackdrop.addEventListener('click', (e) => {
  if (e.target === dirRenameBackdrop) closeDirRenameModal();
});

dirRenameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  dirRenameError.classList.add('hidden');

  if (!dirRenameSourcePath) return;
  const newName = dirRenameInput.value.trim().replace(/^\/+|\/+$/g, '');

  if (!newName) {
    dirRenameError.textContent = t('nameRequired');
    dirRenameError.classList.remove('hidden');

    return;
  }

  if (/[\\\/]/.test(newName)) {
    dirRenameError.textContent = t('noSlashes');
    dirRenameError.classList.remove('hidden');

    return;
  }

  const parts = dirRenameSourcePath.split('/');

  parts[parts.length - 1] = newName;
  const newPath = parts.join('/');

  if (newPath === dirRenameSourcePath) {
    closeDirRenameModal();

    return;
  }

  try {
    const res = await fetch('/api/dir/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: dirRenameSourcePath, to: newPath }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));

      throw new Error(err.error || 'HTTP ' + res.status);
    }

    closeDirRenameModal();
    // Re-key the content caches under the new prefix + update currentFile.
    const oldPrefix = dirRenameSourcePath + '/';
    const newPrefix = newPath + '/';
    const toMove = [];

    for (const k of contentCache.keys()) {
      if (k.startsWith(oldPrefix)) toMove.push(k);
    }

    for (const oldK of toMove) {
      const v = contentCache.get(oldK);

      contentCache.delete(oldK);
      contentCache.set(newPrefix + oldK.slice(oldPrefix.length), v);
    }

    if (currentFile && currentFile.path.startsWith(oldPrefix)) {
      currentFile.path = newPrefix + currentFile.path.slice(oldPrefix.length);
      location.hash = '#' + encodeURIComponent(currentFile.path);
    }

    setStatus(t('folderRenamed'), 'ok');
    await refreshTreeOrReload();
  } catch (err) {
    dirRenameError.textContent = t('errSp', err.message);
    dirRenameError.classList.remove('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!settingsBackdrop.classList.contains('hidden')) {
      closeSettings();

      return;
    }

    if (!newFileBackdrop.classList.contains('hidden')) {
      closeNewFileModal();

      return;
    }

    if (!dirRenameBackdrop.classList.contains('hidden')) {
      closeDirRenameModal();

      return;
    }

    if (!qcBackdrop.classList.contains('hidden')) {
      closeQuickCapture();

      return;
    }

    if (!shareBackdrop.classList.contains('hidden')) {
      closeShareModal();

      return;
    }

    if (!renameBackdrop.classList.contains('hidden')) {
      closeRenameModal();

      return;
    }
  }

  if (
    e.key === 'n' &&
    !window.__viewerMode &&
    !editMode &&
    !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    openNewFileModal();
  }
});
