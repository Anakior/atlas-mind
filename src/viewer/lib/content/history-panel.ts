// The git-history panel. Each doc is versioned git. This panel owns the #history-overlay surface: it
// lists a doc's revisions and shows, per revision, what that commit changed (diff against the previous
// revision) or the full version at that point. Backed by /api/history|diff|revision, which require an
// authenticated admin/viewer — so the button is hidden in offline builds and read-only share views,
// where those endpoints don't exist / return 401. The DOM is written exactly as before
// (innerHTML/createElement/appendChild); the panel's mutable state lives in the instance, and the
// anti-race guards stay object-identity (this.file !== file): a slow load for doc A must not clobber
// doc B. open / available / close are methods on the exported historyPanel, and historyOverlay is
// exported too (graph/keyboard-router.ts reads it for the Escape handler).

import { IS_OFFLINE_BUILD } from '../core/data-csrf';
import { LANG, t } from '../core/i18n';
import { escapeHtml } from '../core/utils';
import { api, setStatus } from '../core/net';
import { currentFile } from '../core/state';
import { Dialogs } from '../modals/dialogs';
import { contentCache } from './content-tree';
import { docRenderer } from './doc-renderer';
import { markdown } from './markdown';
import { stripFrontmatter } from './tags';

export const historyOverlay = document.getElementById('history-overlay')!;
export const historyList = document.getElementById('history-list')!;
export const historyDetail = document.getElementById('history-detail')!;
export const historyPathEl = document.getElementById('history-path')!;

export class HistoryPanel {
  private file: FileNode | null = null;
  // AI-only filter state: showVersion always receives the FULL revisions array + the absolute index,
  // so the diff (parent = revisions[i+1]) stays correct when the list is filtered.
  private allRevisions: Revision[] = [];
  private aiOnly = false;
  private currentSha: string | null = null; // the revision shown in the detail pane (kept across a filter toggle)

  available(file: FileNode | null): file is FileNode {
    // Inline the protocol check rather than reference the `isServerMode` const: DocRenderer.show calls
    // this synchronously before its first await, so on an initial deep-link it can run before that
    // const is initialized (TDZ).
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

  close(): void {
    this.file = null;
    historyOverlay.classList.add('hidden');
  }

  async open(file?: FileNode): Promise<void> {
    // Optional target → the activity feed can peek a doc's history without navigating. Guard on a
    // real file (path is a string): btn-history binds this as a click handler, so a passed MouseEvent
    // (or its array-valued .path on old Chrome) must NOT be taken as `file`.
    const target = file && typeof file.path === 'string' ? file : currentFile;

    if (!this.available(target)) return;
    this.file = target;
    historyPathEl.textContent = target.path;
    historyList.innerHTML = '<div class="text-ink-500 px-2 py-1">…</div>';
    historyDetail.innerHTML = '<div class="text-ink-500">' + escapeHtml(t('historyPick')) + '</div>';
    historyOverlay.classList.remove('hidden');
    let data: { revisions?: Revision[] };

    try {
      data = await api<{ revisions?: Revision[] }>('GET', '/api/history?path=' + encodeURIComponent(target.path));
    } catch (_) {
      if (this.file !== target) return;
      historyList.innerHTML =
        '<div class="text-rose-400 px-2 py-1">' + escapeHtml(t('historyError')) + '</div>';

      return;
    }

    if (this.file !== target) return; // user closed / navigated mid-load
    const revisions = data.revisions || [];

    if (!revisions.length) {
      historyList.innerHTML =
        '<div class="text-ink-500 px-2 py-1">' + escapeHtml(t('historyEmpty')) + '</div>';

      return;
    }

    this.allRevisions = revisions;
    this.aiOnly = false; // each doc opens unfiltered
    this.currentSha = null;
    this.renderHistoryList(target);
  }

  private formatRevDate(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);

    return isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString(LANG, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  private renderHistoryList(file: FileNode): void {
    const revisions = this.allRevisions;
    const hasAi = revisions.some((r) => r.ai);
    const shown = this.aiOnly ? revisions.filter((r) => r.ai) : revisions;
    historyList.innerHTML = '';

    if (hasAi) {
      const tg = document.createElement('button');

      tg.type = 'button';
      tg.className =
        'flex items-center gap-1.5 w-full text-left px-2 py-1.5 mb-1.5 text-xs transition ' +
        (this.aiOnly ? 'text-accent' : 'text-ink-400 hover:text-ink-200');
      tg.innerHTML =
        '<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;' +
        'border-radius:4px;font-size:10px;color:#fff;border:1.5px solid ' +
        (this.aiOnly ? '#1d9bd1' : '#5e6066') + ';background:' +
        (this.aiOnly ? '#1d9bd1' : 'transparent') + '">' + (this.aiOnly ? '✓' : '') + '</span>' +
        escapeHtml(t('historyAiOnly'));
      tg.addEventListener('click', () => {
        this.aiOnly = !this.aiOnly;
        this.renderHistoryList(file);
      });
      historyList.appendChild(tg);
    }

    if (!shown.length) {
      const empty = document.createElement('div');

      empty.className = 'text-ink-500 px-2 py-2 text-xs';
      empty.textContent = t('historyNoAi');
      historyList.appendChild(empty);

      return;
    }

    shown.forEach((rev) => {
      const i = revisions.indexOf(rev); // absolute index → keeps diff/parent correct under the filter
      const when = this.formatRevDate(rev.date);
      const row = document.createElement('button');

      row.type = 'button';
      row.className =
        'history-rev block w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 mb-0.5 transition';
      row.innerHTML =
        '<div class="text-ink-200 truncate">' +
        escapeHtml(rev.subject || '(' + rev.sha.slice(0, 7) + ')') +
        (rev.ai ? ' <span class="text-accent text-xs font-medium">· ' + escapeHtml(rev.ai) + '</span>' : '') +
        '</div>' +
        '<div class="text-xs text-ink-500 font-mono mt-0.5">' +
        escapeHtml(rev.sha.slice(0, 7)) +
        (when ? ' · ' + escapeHtml(when) : '') +
        (rev.author ? ' · ' + escapeHtml(rev.author) : '') +
        '</div>';
      row.addEventListener('click', () => {
        historyList.querySelectorAll('.history-rev').forEach((b) => b.classList.remove('bg-accent/15'));
        row.classList.add('bg-accent/15');
        this.currentSha = rev.sha;
        this.showVersion(file, revisions, i);
      });
      historyList.appendChild(row);
    });
    // Keep the shown revision selected across a filter toggle (no re-fetch → no flash); only auto-load
    // when nothing is selected yet or the selection was filtered out.
    const rows = historyList.querySelectorAll<HTMLButtonElement>('.history-rev');
    const keepIdx = shown.findIndex((r) => r.sha === this.currentSha);
    if (keepIdx >= 0) rows[keepIdx].classList.add('bg-accent/15');
    else rows[0]?.click();
  }

  // `toggle` = { label, handler } for the secondary button: document view ↔ diff view. The document
  // is the default (cf. row click).
  private revisionHeader(
    file: FileNode,
    revisions: Revision[],
    i: number,
    toggle: { label: string; handler: () => void },
  ): HTMLElement {
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
    // Actions in a flex-wrap row (gap, no per-button margin): stay left-aligned whether they sit on
    // one line (desktop) or wrap to two (mobile) — the old marginLeft hack indented the wrapped one.
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
    restore.addEventListener('click', () => this.revertToRevision(file, rev));
    actions.appendChild(restore);
    wrap.appendChild(actions);

    return wrap;
  }

  private async showRevision(file: FileNode, revisions: Revision[], i: number): Promise<void> {
    const rev = revisions[i];
    const parent = revisions[i + 1]; // newest-first → the next entry is the older revision

    historyDetail.innerHTML = '';
    historyDetail.appendChild(
      this.revisionHeader(file, revisions, i, {
        label: 'historyViewVersion',
        handler: () => this.showVersion(file, revisions, i),
      }),
    );
    const body = document.createElement('div');

    body.className = 'text-ink-500';
    body.textContent = '…';
    historyDetail.appendChild(body);

    try {
      if (parent) {
        const data = await api<{ diff?: string }>(
          'GET',
          '/api/diff?path=' +
            encodeURIComponent(file.path) +
            '&from=' +
            parent.sha +
            '&to=' +
            rev.sha,
        );

        if (this.file !== file) return;
        body.replaceWith(
          data.diff && data.diff.trim() ? this.diffToDom(data.diff) : this.simpleNode(t('historyNoChange')),
        );
      } else {
        // Oldest revision: no parent to diff against → show the full version as introduced.
        const data = await api<{ content?: string }>(
          'GET',
          '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
        );

        if (this.file !== file) return;
        body.replaceWith(this.plainTextNode(data.content));
      }
    } catch (_) {
      if (this.file !== file) return;
      body.textContent = t('historyError');
      body.className = 'text-rose-400';
    }
  }

  // Default view when a revision is picked: the DOCUMENT at that revision (what the reader cares
  // about first), with a button to switch to the git diff.
  private async showVersion(file: FileNode, revisions: Revision[], i: number): Promise<void> {
    const rev = revisions[i];

    historyDetail.innerHTML = '';
    historyDetail.appendChild(
      this.revisionHeader(file, revisions, i, {
        label: 'historyViewChanges',
        handler: () => this.showRevision(file, revisions, i),
      }),
    );
    const wrap = document.createElement('div');

    // max-w-none: let the rendered version fill the (now wide) detail pane instead of the default
    // ~65ch prose cap, so md uses the room on large screens.
    wrap.className = 'prose prose-invert max-w-none text-base mt-1';
    wrap.innerHTML = '<p class="text-ink-500">…</p>';
    historyDetail.appendChild(wrap);
    let data: { content?: string };

    try {
      data = await api<{ content?: string }>(
        'GET',
        '/api/revision?path=' + encodeURIComponent(file.path) + '&rev=' + rev.sha,
      );
    } catch (_) {
      if (this.file !== file) return;
      wrap.innerHTML = '<p class="text-rose-400">' + escapeHtml(t('historyError')) + '</p>';

      return;
    }

    if (this.file !== file) return;

    // .html doc: render the past version as-is in a sandboxed iframe (no markdown pipeline), mirroring
    // the live render (cf. renderHtmlFrame). srcdoc set as a property so the raw HTML is never
    // concatenated into the viewer DOM; its JS runs in an opaque origin (allow-scripts, no same-origin)
    // with no access to the viewer's cookies/DOM.
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

    wrap.innerHTML = markdown.render(stripFrontmatter(data.content || '')); // sanitized via DOMPurify
  }

  // Restore a doc to a past revision by writing that content back as a new, forward-moving change
  // (kept in git history). Admin-only server-side; CSRF is auto-injected by the global fetch wrapper.
  private async revertToRevision(file: FileNode, rev: Revision): Promise<void> {
    const ok = await Dialogs.confirm({
      title: t('historyRestore'),
      message: t('historyRestoreConfirm'),
      confirmLabel: t('historyRestoreBtn'),
    });

    if (!ok) return;

    try {
      await api('POST', '/api/revert', { path: file.path, rev: rev.sha });
    } catch (_) {
      setStatus(t('historyRestoreError'), 'err');

      return;
    }

    contentCache.delete(file.path); // force a fresh load of the restored content
    this.close();
    setStatus(t('historyRestored'), 'info');
    docRenderer.show(file);
  }

  private simpleNode(text: string): HTMLElement {
    const d = document.createElement('div');

    d.className = 'text-ink-500';
    d.textContent = text;

    return d;
  }

  private plainTextNode(text?: string): HTMLElement {
    const pre = document.createElement('pre');

    pre.className = 'font-mono text-[15px] leading-relaxed text-ink-300';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.textContent = text || '';

    return pre;
  }

  // Unified diff → escaped, color-coded DOM. Diff colors use inline styles because the green/emerald
  // utilities aren't in the precompiled tailwind.css.
  private diffToDom(diffText: string): HTMLElement {
    const wrap = document.createElement('div');

    wrap.className = 'font-mono text-[15px] leading-relaxed';
    wrap.style.whiteSpace = 'pre-wrap';
    wrap.style.wordBreak = 'break-word';
    // Skip everything before the first @@ (git plumbing: diff --git / index / --- / +++, noise for a
    // reader). Each @@ → a thin separator. After the first @@ every line is content, so a content line
    // starting with --- is rendered, not skipped.
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
}

export const historyPanel = new HistoryPanel();

document.getElementById('btn-history')!.addEventListener('click', () => historyPanel.open());
document.getElementById('history-close')!.addEventListener('click', () => historyPanel.close());
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) historyPanel.close();
});
