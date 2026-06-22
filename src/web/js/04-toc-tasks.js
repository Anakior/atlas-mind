function wireTaskCheckboxes(file, fullContent) {
  // Offline (file://) or read-only shared view: no writing possible.
  if (!isServerMode || window.__viewerMode) return;
  const boxes = contentEl.querySelectorAll('input[type="checkbox"]');

  if (!boxes.length) return;
  let docContent = fullContent;

  boxes.forEach((box, index) => {
    box.disabled = false;
    box.style.cursor = 'pointer';
    box.addEventListener('change', () => {
      const desired = box.checked;
      const newContent = toggleNthTaskMarker(docContent, index, desired);

      if (newContent == null) {
        box.checked = !desired;

        return;
      }

      // Optimistic: advance local state now, PUT in the background, no re-render.
      const prev = docContent;

      docContent = newContent;
      contentCache.set(file.path, newContent);

      if (currentFile && currentFile.path === file.path) currentFile.content = newContent;
      _selfSaveUntil[file.path] = Date.now() + 6000; // mute the self-triggered SSE reload
      // The task's own text (drop nested sub-tasks) → a "checked:/unchecked:" commit subject.
      const li = box.closest('li');
      let taskText = '';

      if (li) {
        const clone = li.cloneNode(true);

        clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
        taskText = clone.textContent.replace(/\s+/g, ' ').trim();
      }

      // Tracked in _taskWrites so the rollup waits for it before reading from disk.
      const write = fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: file.path,
          content: newContent,
          task: { text: taskText, checked: desired },
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);

          return res.json();
        })
        .then((data) => {
          if (currentFile && currentFile.path === file.path && data.mtime)
            currentFile.mtime = data.mtime;
        })
        .catch((e) => {
          // Failure: we roll back the optimistic update (state + visual).
          docContent = prev;
          contentCache.set(file.path, prev);

          if (currentFile && currentFile.path === file.path) currentFile.content = prev;
          box.checked = !desired;
          alert(t('err', e.message));
        });

      _taskWrites.add(write);
      write.finally(() => _taskWrites.delete(write));
    });
  });
}

function buildToc() {
  tocList.innerHTML = '';
  const headings = contentEl.querySelectorAll('h2, h3');

  if (headings.length < 2) {
    tocList.classList.add('hidden'); // no table of contents → no empty area

    if (typeof applyToc === 'function') applyToc();
    else {
      tocPanel.classList.add('hidden');
      tocPanel.classList.remove('flex');
    }

    return;
  }

  tocList.classList.remove('hidden');
  const used = new Set();

  headings.forEach((h) => {
    let id = slugify(h.textContent);
    let base = id,
      n = 2;

    while (used.has(id)) {
      id = base + '-' + n;
      n++;
    }

    used.add(id);
    h.id = id;
    const a = document.createElement('a');

    a.href = '#' + id;
    a.textContent = h.textContent;
    a.className =
      'block px-2 py-1 rounded hover:bg-white/5 text-ink-300 hover:text-accent truncate ' +
      (h.tagName === 'H3' ? 'pl-5 text-[11px] text-ink-400' : 'font-medium');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tocList.appendChild(a);
  });

  if (typeof applyToc === 'function') applyToc();
  else {
    tocPanel.classList.remove('hidden');
    tocPanel.classList.add('flex');
  }
}

function readingTimeFromWords(words) {
  if (!words) return null;
  const minutes = Math.max(1, Math.round(words / 220));

  return { words, minutes };
}

// ─── Backlinks (index pre-computed at build time) ─────────────────────────────
