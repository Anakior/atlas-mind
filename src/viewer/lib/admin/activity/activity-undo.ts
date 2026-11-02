// "Undo this run" in the Journal: the run a feed event belongs to (one writer's burst of commits,
// GET /api/run) opens under its row, saying what undoing it does to each doc; the viewer unticks
// what they keep, then the server reverts the rest in one commit in their name (POST
// /api/run/undo). Docs they could not change by hand stay ticked off and disabled.

import { LANG, t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { setStatus } from '../../core/net';

interface RunDoc {
  path: string;
  change: 'added' | 'modified' | 'deleted' | 'moved';
  from?: string;
  may_undo: boolean;
}

interface RunPreview {
  id: string;
  ai: string | null;
  author: string;
  start: string;
  end: string;
  commits: number;
  documents: RunDoc[];
}

export class ActivityUndo {
  static readonly ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
  // What a refused undo means to the viewer, by status: the run moved on, not theirs, a conflict.
  private static readonly WHY: Record<number, string> = { 404: 'actUndoGone', 403: 'actUndoForbidden', 409: 'actUndoConflict' };

  constructor(private readonly refresh: () => Promise<void>) {}

  // A second click on the same row closes its panel; only one is open at a time.
  async toggle(row: HTMLElement, sha: string): Promise<void> {
    const next = row.nextElementSibling as HTMLElement | null;
    const wasOpen = !!next && next.classList.contains('act-undo-panel') && next.dataset.sha === sha;

    row.parentElement!.querySelectorAll('.act-undo-panel').forEach((p) => p.remove());
    if (wasOpen) return;

    const panel = document.createElement('div');

    panel.className = 'act-undo-panel';
    panel.dataset.sha = sha;
    panel.innerHTML = `<p class="text-ink-500">${t('actUndoLoading')}</p>`;
    row.after(panel);

    const r = await fetch('/api/run?sha=' + encodeURIComponent(sha)).catch(() => null);

    if (!r || !r.ok) {
      this.fail(panel, r && r.status === 404 ? t('actUndoNoRun') : t('err', r ? 'HTTP ' + r.status : 'network'));

      return;
    }
    this.show(panel, (await r.json()) as RunPreview);
  }

  private span(run: RunPreview): string {
    const locale = LANG === 'en' ? 'en-US' : 'fr-FR';
    const time = (d: string) => new Date(d).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const day = new Date(run.end).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    const [a, b] = [time(run.start), time(run.end)];

    return `${day}, ${a === b ? a : a + ' → ' + b}`;
  }

  private what(d: RunDoc): string {
    if (d.change === 'moved') return t('actUndoMovedFrom', d.from);

    return t({ added: 'actUndoAdded', modified: 'actUndoModified', deleted: 'actUndoDeleted' }[d.change]);
  }

  private show(panel: HTMLElement, run: RunPreview): void {
    const who = escapeHtml(run.author) + (run.ai ? ` <span class="text-ink-500">· via ${escapeHtml(run.ai)}</span>` : '');
    const docs = run.documents.map((d) =>
      `<label class="act-undo-doc${d.may_undo ? '' : ' is-locked'}" title="${escapeHtml(d.path)}">
        <input type="checkbox" value="${escapeHtml(d.path)}"${d.may_undo ? ' checked' : ' disabled'}>
        <span class="name">${escapeHtml(d.path.replace(/\.(md|html)$/i, ''))}</span>
        <span class="what">${escapeHtml(d.may_undo ? this.what(d) : t('actUndoNotYours'))}</span>
      </label>`).join('');

    panel.innerHTML =
      `<div class="act-undo-head"><b>${who}</b><span>${this.span(run)} · ${t('actUndoChanges', run.documents.length)}</span></div>
      <p class="text-ink-400">${t('actUndoExplain')}</p>
      <div class="act-undo-docs">${docs}</div>
      <div class="act-undo-actions">
        <button type="button" class="act-undo-go"></button>
        <button type="button" class="act-undo-close">${t('close')}</button>
      </div>
      <p class="act-undo-note">${t('actUndoSafe')}</p>`;

    const go = panel.querySelector<HTMLButtonElement>('.act-undo-go')!;
    const boxes = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    const ticked = () => boxes.filter((b) => b.checked).map((b) => b.value);
    const label = () => {
      const n = ticked().length;

      go.textContent = t('actUndoGo', n);
      go.disabled = n === 0;
    };

    boxes.forEach((b) => b.addEventListener('change', label));
    label();
    panel.querySelector('.act-undo-close')!.addEventListener('click', () => panel.remove());
    go.addEventListener('click', () => {
      const paths = ticked();

      // Every doc ticked: the whole run, the docs this viewer cannot see included.
      this.undo(panel, run.id, paths.length === boxes.length ? undefined : paths);
    });
  }

  private async undo(panel: HTMLElement, run: string, paths?: string[]): Promise<void> {
    panel.classList.add('is-busy');

    const r = await fetch('/api/run/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run, paths }),
    }).catch(() => null);

    if (!r || !r.ok) {
      const why = r && ActivityUndo.WHY[r.status];

      this.fail(panel, why ? t(why) : t('err', r ? 'HTTP ' + r.status : 'network'));

      return;
    }
    setStatus(t('actUndone'), 'ok');
    await this.refresh();
  }

  private fail(panel: HTMLElement, message: string): void {
    panel.classList.remove('is-busy');
    panel.innerHTML = `<p class="act-undo-error">${escapeHtml(message)}</p>`;
  }
}
