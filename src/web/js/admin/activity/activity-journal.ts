// Journal view of the home Activity card: the chronological feed grouped by day, each row carrying an
// avatar + actor + verb phrase + relative time, with an in-place "see all" expand toggle. A render-only
// view — it reads the filtered feed, the journal toggles and the helper cluster through the
// ActivityRenderCtx the shell hands it (the shell owns the state and the card-level wiring). Top-level
// (no IIFE) so it is a shared symbol in the concat scope.
class ActivityJournal {
  constructor(private readonly ctx: ActivityRenderCtx) {}

  private row(e: ActivityItem): string {
    const ty = this.ctx.TY(e.type);
    const via = e.ai ? `<span class="text-ink-500 text-xs">· via ${escapeHtml(e.ai)}</span>` : '';

    return (
      `<div class="act-row flex items-center gap-3" data-path="${escapeHtml(e.path)}" data-tip="${escapeHtml(t('actSeeChanges'))}">
        <div class="relative shrink-0" style="line-height:0">${this.ctx.avatar(e, 30)}${e.ai ? this.ctx.aiBadge(e.ai) : ''}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5"><span class="text-sm font-semibold text-ink-100">${escapeHtml(e.who)}</span>${via}</div>
          <div class="flex items-center gap-1.5 text-sm mt-0.5">
            <span class="shrink-0" style="line-height:0">${this.ctx.iconSvg(e.type, 14)}</span>
            <span class="shrink-0" style="color:${ty.color};font-weight:600;white-space:nowrap">${this.ctx.verbPhrase(e.type)}</span>
            <span class="text-ink-300 truncate min-w-0">${escapeHtml(e.title)}</span>
            ${e.count && e.count > 1 ? `<span class="text-ink-500 text-xs shrink-0">×${e.count}</span>` : ''}
          </div>
        </div>
        <div class="shrink-0 text-xs text-ink-500 font-mono" title="${escapeHtml(e.sha)}">${this.ctx.rel(e.agoMin)}</div>
      </div>`
    );
  }

  html(): string {
    const all = this.ctx.shownItems();

    if (!all.length) return `<div class="text-ink-500 text-sm py-4 text-center">${this.ctx.aiOnly ? t('actEmptyAi') : t('actEmpty')}</div>`;

    let out = '';
    let day = '';
    const shown = this.ctx.expanded ? all : all.slice(0, ActivityIcons.JOURNAL_PREVIEW);

    shown.forEach((e) => {
      const k = this.ctx.dayKey(e.agoMin);

      if (k !== day) {
        day = k;
        out += `<div class="text-[11px] uppercase tracking-wider text-ink-500 font-semibold mt-3 mb-1 first:mt-0">${escapeHtml(day)}</div>`;
      }
      out += this.row(e);
    });
    // Toggle in place, no extra view to navigate to, the feed just unfolds.
    if (all.length > ActivityIcons.JOURNAL_PREVIEW) {
      out += `<div class="text-right mt-3"><a class="act-seeall text-sm text-accent hover:underline cursor-pointer">${this.ctx.expanded ? t('actCollapse') : t('actSeeAll')}</a></div>`;
    }

    return out;
  }
}
