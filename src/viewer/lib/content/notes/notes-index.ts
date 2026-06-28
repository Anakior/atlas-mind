// Notes index → tree badges: loads the {path: count} map and stamps a count badge on each tree link.
//
// These MUST stay hoisted `function` declarations (not const/arrow): 02-content-tree's offline boot
// calls decorateTreeBadges() during its own module eval, and 02 concatenates BEFORE this file — only a
// function declaration hoists script-wide so that early call resolves. Online: _notes-index.json ;
// offline: EMBED_NOTES. notesIndex ({path: count}) is declared in 02-content-tree (early enough to be
// initialized before that boot reads it).
async function loadNotesIndex(): Promise<Record<string, number>> {
  if (notesIndex) return notesIndex;

  if (IS_OFFLINE_BUILD) {
    notesIndex = {};

    for (const p in EMBED_NOTES || {}) notesIndex[p] = EMBED_NOTES[p].length;

    return notesIndex;
  }

  try {
    const res = await fetch('/_notes-index.json', { cache: 'no-cache' });

    notesIndex = res.ok ? await res.json() : {};
  } catch (e) {
    notesIndex = {};
  }

  return notesIndex!;
}

async function decorateTreeBadges(): Promise<void> {
  const idx = await loadNotesIndex();

  document.querySelectorAll('.kb-tree-badge').forEach((b) => b.remove());

  for (const path in idx) {
    const link = treeEl.querySelector('a[data-path="' + CSS.escape(path) + '"]');

    if (!link) continue;
    const badge = document.createElement('span');

    badge.className = 'kb-tree-badge';
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg><span>' +
      idx[path] +
      '</span>';
    badge.title = t('notesBadge', idx[path]);
    link.appendChild(badge);
  }
}
