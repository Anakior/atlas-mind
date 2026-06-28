// Document tags, split by concern but sharing one content-area surface:
//   • DocTags   — renders the doc-tag chips (an HTML string spliced into 06-view-history's #content
//                 innerHTML; routing it through the runtime's render() would leave its per-container
//                 ROOTS map stale and corrupt the next diff, so it stays a string builder).
//   • TagStore  — the tag data layer: the `tags:` frontmatter rewrite, the PUT /api/file persist, and
//                 the all-tags aggregate the editor autocompletes from. After a successful write it
//                 re-renders the chips in place through the injected DocTags.
//   • TagEditor — the body-anchored tag-editor popup island (like 13-combobox's pop): created on open,
//                 torn down on close, placed via getBoundingClientRect. It also owns the content-area
//                 click delegation (chips + [[wikilink]]s) and the outside-click close; tag mutations
//                 delegate to the injected TagStore, and a chip click hands off to showTag.
//
// The "all docs with #tag" browse page (showTag) lives in 08b-tag-browse.ts.
//
// folderTagsOf / stripFrontmatter / mdInsert* are stateless cross-cutting utils; they stay top-level
// globals because 06/09/12 and 22-inbox call them bare in the shared bundle scope. renderDocTags gets
// a thin top-level wrapper for the same reason. (highlightFirstMatch moved to 04c-content-decorators.)

import { IS_OFFLINE_BUILD } from '../core/data-csrf';
import { t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { fileMap } from '../core/tree';
import { contentEl } from '../core/dom-refs';
import { currentFile, editTextarea } from '../core/state';
import { Dialogs } from '../modals/dialogs';
import { AtlasCombobox } from '../ui/combobox';
import { loadContent, contentCache } from './content-tree';
import { tagBrowsePage } from './tag-browse';
import { docRenderer } from './doc-renderer';

export function stripFrontmatter(text: string): string {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

export function folderTagsOf(path: string): string[] {
  return path
    .split('/')
    .slice(0, -1)
    .map((s) => s.toLowerCase());
}

// ---- doc-tag chips (an HTML string spliced into 06-view-history's #content innerHTML) ----
export class DocTags {
  renderDocTags(file: FileNode | null): string {
    if (!file || file.ext !== '.md') return '';

    // Mirror doc = read-only: no +/× (any tag write would 403).
    const canEdit = !IS_OFFLINE_BUILD && !window.__viewerMode && !(file.path || '').startsWith('remotes/');
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
      (canEdit ? '<button class="doc-tag-add" title="' + escapeHtml(t('addTag')) + '">+</button>' : '') +
      '</div>'
    );
  }
}

// ---- the tag data layer: frontmatter rewrite, persist, and the all-tags aggregate ----
export class TagStore {
  constructor(private readonly docTags: DocTags) {}

  allTagsList(): string[] {
    const s = new Set<string>();

    for (const f of Object.values(fileMap)) {
      if (f.ext === '.md') for (const tg of f.tags || []) s.add(tg);
    }

    return [...s].sort();
  }

  // Rewrites the `tags:` frontmatter key (custom tags only — folder tags are derived at build).
  // Empty list → removes the key (and the frontmatter block if it empties).
  private static setFrontmatterTags(content: string, customTags: string[]): string {
    const tagsLine = customTags.length ? 'tags: [' + customTags.join(', ') + ']' : null;
    const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);

    if (m) {
      const lines = m[1].split(/\r?\n/);
      const out: string[] = [];

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

  // Persists custom tags: rewrite frontmatter, PUT /api/file (server rebuilds + commits), then update
  // fileMap and re-render the chips in place.
  private async persistTags(file: FileNode, customTags: string[]): Promise<boolean> {
    let loaded: string;

    try {
      loaded = await loadContent(file);
    } catch {
      return false;
    }

    const newContent = TagStore.setFrontmatterTags(loaded, customTags);

    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content: newContent }),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) {
      Dialogs.notifyError('tagSaveFailed', (err as Error).message);

      return false;
    }

    contentCache.set(file.path, newContent);
    file.content = newContent;
    const merged = folderTagsOf(file.path);

    for (const tg of customTags) if (!merged.includes(tg)) merged.push(tg);
    file.tags = merged;

    if (currentFile === file) {
      const wrap = contentEl.querySelector('.doc-tags');

      if (wrap) wrap.outerHTML = this.docTags.renderDocTags(file);
    }

    return true;
  }

  async addCustomTag(file: FileNode | null, tag: string): Promise<void> {
    tag = (tag || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');

    if (!file || !tag) return;

    const folderSet = new Set(folderTagsOf(file.path));

    if (folderSet.has(tag)) return; // already covered by the folder

    const custom = (file.tags || []).filter((tg) => !folderSet.has(tg));

    if (custom.includes(tag)) return;

    custom.push(tag);
    await this.persistTags(file, custom);
  }

  async removeCustomTag(file: FileNode | null, tag: string): Promise<void> {
    if (!file) return;

    const folderSet = new Set(folderTagsOf(file.path));
    const custom = (file.tags || []).filter((tg) => !folderSet.has(tg) && tg !== tag);

    await this.persistTags(file, custom);
  }
}

// ---- the tag-editor popup island + the content-area click delegation ----
export class TagEditor {
  // The tag-editor popup wrapper (z-50, body-anchored). Only static class string worth hoisting.
  private static readonly EDITOR_CLASS =
    'fixed z-50 w-64 bg-navy-800 border subtle-border rounded-lg shadow-2xl shadow-black/70 p-3';

  // The popup island: created on open, torn down on close. The combobox is mounted on its input and
  // owns its own body-level dropdown (refresh re-pulls the tag list after a new tag is committed).
  private editorEl: HTMLElement | null = null;
  private editorCb: { destroy(): void; refresh(): void } | null = null;

  constructor(private readonly store: TagStore) {}

  private closeEditor(): void {
    if (this.editorCb) {
      this.editorCb.destroy();
      this.editorCb = null;
    }
    if (this.editorEl) {
      this.editorEl.remove();
      this.editorEl = null;
    }
  }

  private openEditor(file: FileNode | null, anchorEl: Element): void {
    if (!file) return;
    this.closeEditor();

    const folderSet = new Set(folderTagsOf(file.path));
    const el = document.createElement('div');

    el.id = 'tag-editor';
    el.className = TagEditor.EDITOR_CLASS;
    el.innerHTML =
      '<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mb-2 font-sans">' +
      t('tagEditorTitle') +
      '</div>' +
      '<div id="tag-ed-list" class="flex flex-wrap gap-1.5 mb-2"></div>' +
      '<input id="tag-ed-input" placeholder="' +
      escapeHtml(t('tagPlaceholder')) +
      '" autocomplete="off" class="w-full px-3 py-2 text-sm bg-black/30 border subtle-border rounded text-ink-100 placeholder-ink-500 focus:outline-none focus:ring-2 focus:ring-accent/40">' +
      '<div class="text-[10px] text-ink-500 mt-1.5 font-sans">' +
      t('tagEditorHint') +
      '</div>';
    document.body.appendChild(el);
    this.editorEl = el;
    const r = anchorEl.getBoundingClientRect();

    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 272)) + 'px';
    el.style.top = r.bottom + 6 + 'px';
    const input = el.querySelector('#tag-ed-input') as HTMLInputElement;
    const renderList = (): void => {
      const cur = (file.tags || []).filter((tg) => !folderSet.has(tg));
      const box = el.querySelector('#tag-ed-list')!;

      box.innerHTML = cur.length
        ? cur
          .map(
            (tg) =>
              '<span class="doc-tag" style="cursor:default">#' +
              escapeHtml(tg) +
              '<button class="doc-tag-x" data-ed-rm="' +
              escapeHtml(tg) +
              '">×</button></span>',
          )
          .join('')
        : '<span class="text-[11px] text-ink-500">' + t('noCustomTags') + '</span>';
      box.querySelectorAll('[data-ed-rm]').forEach((b) =>
        b.addEventListener('click', async () => {
          await this.store.removeCustomTag(file, (b as HTMLElement).dataset.edRm!);
          renderList();
        }),
      );
    };

    renderList();
    this.editorCb = AtlasCombobox(input, {
      source: () => this.store.allTagsList(),
      creatable: true,
      onSelect: async (v: string) => {
        input.value = '';
        if (v && v.trim()) {
          await this.store.addCustomTag(file, v);
          renderList();
          this.editorCb!.refresh();
        }
      },
    }) as { destroy(): void; refresh(): void };
    input.focus();
    input.addEventListener('keydown', (e) => {
      // Enter is handled by the combobox (select/create → onSelect). Escape here closes the editor
      // (the combobox swallowed it if its dropdown was open).
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor();
      }
    });
  }

  // ---- delegation + outside-click wiring (top-level side effects in the old .js) ----
  init(): void {
    // Close the popup on any outside click — but not on the + button, which toggles it.
    document.addEventListener('click', (e) => {
      const target = e.target as Element;

      if (this.editorEl && !this.editorEl.contains(target) && !target.closest('.doc-tag-add')) {
        this.closeEditor();
      }
    });

    // Clicks on tag chips and wikilinks rendered in the content.
    contentEl.addEventListener('click', (e) => {
      const target = e.target as Element;
      const rm = target.closest('[data-removetag]');

      if (rm) {
        e.preventDefault();
        e.stopPropagation();
        this.store.removeCustomTag(currentFile, (rm as HTMLElement).dataset.removetag!);

        return;
      }

      const add = target.closest('.doc-tag-add');

      if (add) {
        e.preventDefault();
        this.openEditor(currentFile, add);

        return;
      }

      const tagBtn = target.closest('.doc-tag') as HTMLElement | null;

      if (tagBtn && tagBtn.dataset.tag) {
        e.preventDefault();
        tagBrowsePage.showTag(tagBtn.dataset.tag);

        return;
      }

      const wl = target.closest('a.wikilink') as HTMLElement | null;

      if (wl) {
        e.preventDefault();
        const f = wl.dataset.path ? fileMap[wl.dataset.path] : undefined;

        if (f) {
          docRenderer.show(f);
          history.replaceState(null, '', '#' + encodeURIComponent(f.path));
        }
      }
    });
  }
}

export const docTags = new DocTags();
export const tagStore = new TagStore(docTags);
export const tagEditor = new TagEditor(tagStore);

tagEditor.init();

// ---- markdown insert primitives (09-editor's toolbar) — operate on the editTextarea island ----
export function mdInsertWrap(before: string, after: string, placeholderIfEmpty?: string): void {
  const ta = editTextarea;

  if (!ta) return;

  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.substring(start, end) || placeholderIfEmpty || '';
  const replacement = before + sel + after;

  ta.setRangeText(replacement, start, end, 'end');

  if (!ta.value.substring(start, end + replacement.length - (before.length + after.length))) {
    ta.selectionStart = ta.selectionEnd = start + before.length + sel.length;
  } else {
    ta.selectionStart = start + before.length;
    ta.selectionEnd = start + before.length + sel.length;
  }

  ta.dispatchEvent(new Event('input'));
}

export function mdInsertLineStart(prefix: string): void {
  const ta = editTextarea;

  if (!ta) return;

  const v = ta.value;
  const start = ta.selectionStart;
  let lineStart = start;

  while (lineStart > 0 && v[lineStart - 1] !== '\n') lineStart--;
  ta.setRangeText(prefix, lineStart, lineStart, 'end');
  ta.selectionStart = ta.selectionEnd = start + prefix.length;
  ta.dispatchEvent(new Event('input'));
}

export function mdInsertAtCursor(text: string): void {
  const ta = editTextarea;

  if (!ta) return;

  const start = ta.selectionStart;

  ta.setRangeText(text, start, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input'));
}
