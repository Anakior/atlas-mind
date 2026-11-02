// Journal view of the home Activity card: the chronological feed grouped by day, each row carrying an
// avatar + actor + verb phrase + relative time, with an in-place "see all" expand toggle. A render-only
// view — it reads the filtered feed, the journal toggles and the helper cluster through the
// ActivityRenderCtx the shell hands it (the shell owns the state and the card-level wiring).

import { t } from '../../core/i18n';
import { escapeHtml } from '../../core/utils';
import { IS_OFFLINE_BUILD } from '../../core/data-csrf';
import { ActivityIcons } from './activity-icons';
import { ActivityUndo } from './activity-undo';

// Runs are kept this long server-side: an older change has none left to undo.
const RUN_WINDOW_MIN = 30 * 24 * 60;

export class ActivityJournal {
  constructor(private readonly ctx: ActivityRenderCtx) {}

  private row(e: ActivityItem): string {
    const ty = this.ctx.TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${escapeHtml(e.ai)}</span>` : '';
    const undo = !IS_OFFLINE_BUILD && e.sha && e.agoMin < RUN_WINDOW_MIN
      ? `<button type="button" class="act-undo" data-sha="${escapeHtml(e.sha)}" data-tip="${escapeHtml(t('actUndo'))}" aria-label="${escapeHtml(t('actUndo'))}">${ActivityUndo.ICON}</button>`
      : '';

    // A doc still in the mind opens from its title or the hover button; a deleted or moved one only
    // has its history left.
    const live = this.ctx.hasDoc(e.path);
    const openTip = escapeHtml(t('actOpenDoc'));
    const title = live
      ? `<a class="act-open act-title text-ink-300 truncate min-w-0" href="#${encodeURIComponent(e.path)}" data-tip="${openTip}">${escapeHtml(e.title)}</a>`
      : `<span class="text-ink-300 truncate min-w-0">${escapeHtml(e.title)}</span>`;
    const open = live
      ? `<button type="button" class="act-open act-open-btn" data-tip="${openTip}" aria-label="${openTip}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg></button>`
      : '';

    return (
      `<div class="act-row flex items-center gap-3" data-path="${escapeHtml(e.path)}" data-tip="${escapeHtml(t('actSeeChanges'))}">
        <div class="relative shrink-0" style="line-height:0">${this.ctx.avatar(e, 30)}${e.ai ? this.ctx.aiBadge(e.ai) : ''}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${escapeHtml(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            <span class="shrink-0" style="line-height:0">${this.ctx.iconSvg(e.type, 14)}</span>
            <span class="shrink-0" style="color:${ty.color};font-weight:600;white-space:nowrap">${this.ctx.verbPhrase(e.type)}</span>
            ${title}
            ${e.count && e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ''}
          </div>
        </div>
        ${open}${undo}
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${escapeHtml(e.sha)}">${this.ctx.rel(e.agoMin)}</div>
      </div>`
    );
  }

  // The home shows the first entries and a "See all" toggle; the menu's panel (full) shows them all.
  html(full = false): string {
    const all = this.ctx.shownItems();

    if (!all.length) return `<div class="text-ink-500 text-sm py-4 text-center">${this.ctx.aiOnly ? t('actEmptyAi') : t('actEmpty')}</div>`;

    let out = '';
    let day = '';
    const shown = full || this.ctx.expanded ? all : all.slice(0, ActivityIcons.JOURNAL_PREVIEW);

    shown.forEach((e) => {
      const k = this.ctx.dayKey(e.agoMin);

      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${escapeHtml(day)}</div>`;
      }
      out += this.row(e);
    });
    // Toggle in place, no extra view to navigate to, the feed just unfolds.
    if (!full && all.length > ActivityIcons.JOURNAL_PREVIEW) {
      out += `<div class="act-seeall-row text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${this.ctx.expanded ? t('actCollapse') : t('actSeeAll')}</a></div>`;
    }

    return out;
  }
}
